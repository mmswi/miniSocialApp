# The email pipeline: one seam, three transports

> Increment: `feature/auth` — wiring real outbound email behind the `sendEmail` seam.
> Files: `src/lib/email.ts`, `src/lib/env.ts`, `docker-compose.yml` (Mailpit), and the message
> templates in `src/auth/verify.ts`. Sends are triggered from `src/auth/password-auth.ts`.

Docs 04 and 06 kept saying "we email the user."

Doc 04: a verification link. Doc 06: a "you already have an account" notice.

Neither said *how* an email actually leaves the process and lands in an inbox.

This is that part. And the interesting thing is that "send an email" means three completely different things depending on where the code is running.

## Start with the bad version

The obvious way to send mail is to call the provider right where you need it:

```ts
// in the signup handler
await resend.emails.send({ from, to, subject, html })
```

Three things break.

Your **tests** now hit the network — or you mock the Resend SDK in every test that touches signup.

A **slow provider** stalls the signup request, because the user is waiting on an API call to a third party.

And you've **welded** the signup flow to one vendor. Swap Resend for SES and you edit every call site.

The fix is a seam. One function, `sendEmail`, that every caller uses — and behind it, a transport chosen by environment.

## The seam

Everything that sends mail calls exactly this:

```ts
sendEmail({ to, subject, text })
```

That's the whole interface. A recipient, a subject, a body. No provider, no SMTP, no SDK in sight.

Who calls it? Never the route directly. Two small **templates** do, each owning one message:

```ts
// src/auth/verify.ts — these decide WHAT to say
sendVerificationEmail(to, rawToken)   // "Confirm your email: <APP_URL>/auth/verify?token=…"
sendAccountExistsEmail(to)            // "You already have an account — just log in."
```

So the layers are clean:

```
signupWithPassword        WHEN to send   (and that a failure must not break signup — below)
  ↓
sendVerificationEmail     WHAT to say    (subject + body + the link)
  ↓
sendEmail                 WHERE to send  (picks the transport)
  ↓
the transport             HOW it travels (memory, or an SMTP socket)
```

Each layer knows only the one below it. The template doesn't know about SMTP. The route doesn't know about either.

## Three transports, chosen by NODE_ENV

Here is the part that surprises people. `sendEmail` does three different things, and the only input that decides which is `NODE_ENV`:

```
sendEmail(message)
├─ test         → push onto sentEmails[]        (no network at all)
├─ development  → SMTP → Mailpit                (localhost:1025, viewable at :8025)
└─ production   → SMTP → a real provider        (SMTP_HOST / USER / PASS from env)
```

```ts
export const sendEmail = async (message) => {
  if (env.NODE_ENV === 'test') {
    sentEmails.push(message)   // an array in memory
    return
  }
  await mailer().sendMail({ from: env.EMAIL_FROM, to: message.to, ... })
}
```

**Under test, there is no email.** `sentEmails` is a plain array. A test signs up, then reads the array back to find the link that was "sent":

```ts
const link = sentEmails.find((m) => m.to === email)?.text.match(/token=(\S+)/)?.[1]
```

That's how the verification E2E test gets the token without a mail server. No network, no flake, instant.

**Under dev and prod, it's the same code** — `mailer().sendMail(...)` over SMTP. The *only* difference is where the socket points, and that's pure config (env), not code. Dev points at Mailpit; prod points at Resend or SES. The app never knows the difference.

## Mailpit is a fake inbox you can see

In dev, `SMTP_HOST=localhost` and `SMTP_PORT=1025` reach the **Mailpit** container from `docker-compose`.

Mailpit speaks SMTP like a real server, but it never delivers anything. It just *catches* every message and shows it in a web UI at `http://localhost:8025`.

So you sign up, switch to that tab, and there's the verification email — click the link, you're verified. A real round trip, nothing leaving your laptop, no account anywhere.

In production those same env vars point at a provider that *does* deliver. Same SMTP, real inbox.

## The connection is a singleton

`mailer()` doesn't build a new connection per email:

```ts
const mailer = () => {
  globalForMailer.mailer ??= createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, ... })
  return globalForMailer.mailer
}
```

One transporter per process, cached on `globalThis` (so dev hot-reload reuses it instead of leaking a socket each reload — the same pattern as the DB pool and Redis client).

It's also lazy: `createTransport` opens no socket. The connection happens on the first `sendMail`. So importing `email.ts` costs nothing — the import stays side-effect-free even though the module owns a connection.

## A failed send must not fail the signup

One rule the pipeline has to honor: the user row is already committed by the time we send. If the mail throws, the signup must still succeed.

Two reasons. First, it would be absurd to destroy an account because a third-party mail API hiccupped. Second — and sharper — on the duplicate path a thrown send would change the response, and **that reopens the enumeration oracle doc 06 just closed**: success returns `200`, a throw returns `500`, and now new-vs-taken is distinguishable again.

So both sends go through a best-effort wrapper:

```ts
const sendSignupEmail = async (send) => {
  try { await send() }
  catch (error) { console.error('[signup] email failed to send; signup still succeeds', error) }
}
```

Both call sites — verification (new) and account-exists (taken) — use it identically, so their failure behavior can't diverge. `sendEmail` itself still throws honestly; it's the *signup flow* that chooses to swallow, because only it knows the row is already there.

## The whole flow, one example

Mara signs up.

```
signupWithPassword                                   (server)
↓ create user + verification token (token hash stored; raw token rides the email — doc 04)
↓
sendVerificationEmail(mara@…, rawToken)              (server) builds subject + APP_URL/auth/verify?token=…
↓
sendEmail({ to, subject, text })                     (server) picks transport by NODE_ENV
↓
mailer().sendMail(...)  → SMTP → Mailpit             (external) dev: caught at :8025
↓
Mara opens her inbox and clicks the link             (client)
```

The five questions:

    Where does each step run?  All server-side except Mara reading the mail (client) and the SMTP server itself (external — Mailpit in dev, a provider in prod).
    What shape is the data?    text → { to, subject, text } → SMTP wire bytes.
    What gets stored?          Nothing about the email persists in our DB — only the token's hash (doc 04). Mailpit keeps a copy in dev so you can read it; a provider keeps its own log.
    What's computed fresh?     The subject, body, and link, on every send.
    What's handed onward?      The { to, subject, text } from template to seam to socket.

## When this is the wrong shape

**The send is synchronous.** Mara's signup waits for `sendMail` to finish. Mailpit is instant and the fail-soft wrapper means a slow provider won't *fail* the request — but it can still *slow* it. The real fix is a queue: enqueue the message, return immediately, let a worker deliver and retry. That's deliberately later hardening, not here.

**We don't store sent mail.** There's no "resend" or audit log in the app; the token table (doc 04) is the only durable trace. Fine for now, not for a system that must prove it sent a notice.

The template decides what to say.
The seam decides where it goes.
The environment decides whether "there" is an array, a catcher, or a real inbox.
