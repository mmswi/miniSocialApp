# Uniform signup: the same answer, whether you exist or not

> Increment: `feature/auth` — A9, closing the signup enumeration gap.
> Files: `src/auth/password-auth.ts`, `src/auth/routes.ts`, `src/auth/verify.ts`.
> Finishes the thread doc 04 opened; the login version of this leak is doc 02.

Doc 04 ended on a promise:

> A uniform signup response becomes possible… moving the real signal into the inbox instead of the HTTP status. That's a later increment; today a duplicate signup still returns `409`.

This is that increment.

Doc 04 already built the channel — a verification email, sent at signup, that proves you own the address. This doc doesn't touch that machinery. It changes one thing: **what the signup endpoint says out loud.** So nothing here re-explains tokens or sending mail. Read doc 04 for that. Read this for why the *response* had to change, and what that broke.

## The tell

Before A9, signup answered two different ways:

```
POST /auth/signup  { new@x.com }     → 201 Created   + a session cookie
POST /auth/signup  { taken@x.com }   → 409 Conflict  { "error": "email_taken" }
```

The `409` says, out loud: **someone already has this email here.**

That's the same leak doc 02 closed on *login* — just on the other door. An attacker with a list of ten thousand addresses POSTs each one and writes down the status code. Every `409` is a confirmed member.

On a public site, membership is no secret. On redline — a private tool for reviewing confidential documents — *who is on it* is the client list. The attacker reads it off the status codes, no password-guessing required.

## The fix: one answer for everyone

Both paths now return the identical response:

```
POST /auth/signup  { new@x.com }     → 200  "Check your email to finish signing up."
POST /auth/signup  { taken@x.com }   → 200  "Check your email to finish signing up."
                                        ↑ byte-for-byte the same
```

Same status, same body, no `error` field. The attacker's whole list comes back as `200`s. Nothing to write down.

## The signal already had a home

The response can't carry the new-vs-taken signal now — so it goes where doc 04 already pointed: the inbox, a channel only the address owner can read.

```
new email    → the verification email from doc 04        ("Confirm your email: <link>")
taken email  → one new message, sendAccountExistsEmail   ("You already have an account — just log in.")
```

Only the second email is new in this increment. The first is doc 04's, unchanged. In code, the duplicate that used to throw now sends instead:

```ts
} catch (error: unknown) {
  // Was: throw conflict('email_taken'). Now: tell the real owner by email, return the uniform 200.
  if (isUniqueViolation(error)) {
    await sendAccountExistsEmail(email)
    return
  }
  throw error
}
```

The attacker can hit the endpoint ten thousand times and can't read one of those inboxes. The signal is real; it just travels where they can't follow.

## The consequence: signup stops logging you in

This is the part that isn't obvious, and it's the actual cost of A9.

The old new-email response set a **session cookie** — signup logged you straight in. A uniform response can't.

Because the taken path has no session to grant. That account isn't yours; you proved nothing by typing its address. So watch what happens if only the new path keeps its cookie:

```
new email    → 200 + Set-Cookie: session=...
taken email  → 200   (no cookie)
                ↑ the cookie is the tell again
```

The *presence of the cookie* becomes the difference the attacker was hunting. We'd have moved the leak from the status code into the `Set-Cookie` header and called it fixed.

So neither path sets one.

```
before:  sign up ──────────────────► you're in
after:   sign up → check email → log in → you're in
```

Signup says "check your email," cookie-free, every time. Logging in is now a separate step — `POST /login`, or the verification link. One extra step on the happy path, paid because *"sometimes a session, sometimes not"* is exactly the oracle we're closing.

## Then why does Google signup still log you in?

It does — `signInWithGoogle` opens a session in all three cases, and the callback sets the cookie. That looks like a contradiction. It isn't, because the two reasons password signup had to give up auto-login don't exist in the Google flow:

- **No enumeration vector.** To even reach the "do you already have an account?" branch, you must *first* complete the OAuth handshake — prove to Google you control that account. An attacker can't probe `alice@gmail.com` without being alice at Google. The password leak was an *unauthenticated* request revealing membership; by the time Google's callback runs, the request is already authenticated. There's no anonymous oracle, so withholding the session would buy nothing.

- **The email is already proven.** Password signup also couldn't log you in because the address was an unverified *claim* (doc 04). Google sends `emailVerified`, and a new user inherits it. Ownership is already proven, so there's no "check your email" to wait on.

So: password signup withheld the session because the request was anonymous and the email unproven. Google signup is neither — so it logs you in, and that's correct, not an exception.

## The second tell: time

Identical bodies aren't enough; the clock can still leak.

argon2id hashing is deliberately slow (~50ms) and is the dominant cost of a signup. If the taken path skipped it — hashing only when it's about to create the account — it would reply ~50ms sooner, and the attacker just stops reading the body and starts timing:

```
fast reply  → email is taken
slow reply  → email is new
```

So we hash on **both** paths, before the insert is even attempted. The taken path hashes a password it throws away — not waste, a timing equalizer, the same move login makes with its decoy hash in doc 02. A future reader who "optimizes" the hash to after the insert would silently reopen the oracle, which is why the code says so at that line.

## The whole flow

```
POST /auth/signup
↓
hashPassword(password)  ~50ms            (BOTH paths — timing equalizer)
↓
try: insert users + accounts in one tx
│
├── success ──► verification email (doc 04) ──┐
│                                             │
└── 23505  ──► sendAccountExistsEmail() ──────┤
                                              ↓
                200 "Check your email to finish signing up."
                (identical body, no cookie, either way)
```

Two paths in, one answer out. Stored on the new path: one `users` row + one `accounts` row. Stored on the taken path: nothing. Computed every time, on every path: the hash. Handed onward: not a session — an email.

## When this is the wrong shape

If membership isn't a secret — a forum, a game — the uniform response buys little and costs every new user an extra step; a plain `409 "email taken"` is friendlier and fine. It earns its cost only where *who is registered* is itself confidential: a private review tool, a medical portal, an internal admin. redline is one of those, so we pay the step.

The endpoint tells everyone the same thing.
The inbox tells the one person allowed to know.
The clock tells no one anything.
