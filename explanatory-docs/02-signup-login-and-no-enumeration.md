# Signup, login, logout — and the leak hiding in the error message

> Increment: `feature/auth` — the password auth service and the `/auth` HTTP routes.
> Files: `src/auth/routes.ts`, `src/auth/password-auth.ts`, `src/auth/cookies.ts`,
> building on `src/auth/session.ts`, `src/auth/password.ts`, `src/db/schema.ts`.

Doc 01 built the parts: how a password is hashed, how a session token is stored, how a cookie maps back to a user.

This is the assembly.

Mara clicks **Sign in**.

Between that click and the screen that says *Welcome back* there is one HTTP request, four files, and exactly one round trip.

Let's follow the request all the way through — and then look at the one place where a careless answer leaks Mara's privacy.

---

## The shape of a request

Everything here runs on the **server**. The browser's whole job is to send a little JSON and, later, to hold a cookie.

```
Browser                         Server
  │   POST /auth/login           │
  │   { email, password }   ───► │  routes.ts      validate the body
  │                              │  password-auth  check the credential
  │                              │  session.ts     mint a session
  │   ◄───  Set-Cookie + user    │  cookies.ts     write the cookie
  ▼                              ▼
```

Four steps, always in this order: **validate → authenticate → mint → set cookie.**

Each hands the next a smaller, more-trusted thing.

The body comes in as `unknown`.

The validator turns it into a typed `{ email, password }`.

The service turns that into a `userId`.

The session turns the `userId` into a raw token.

The cookie carries the token back to the browser.

That is the whole flow. The rest of this doc is *why each step is shaped the way it is.*

---

## Step one: the body is guilty until proven typed

The request body is whatever the client sent. It could be anything.

So the first thing `routes.ts` does is refuse to trust it:

```ts
const signupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  name: z.string().trim().min(1).max(100).optional(),
})
```

If the email is malformed or the password is too short, the request dies here with a `400` and a field message. It never reaches the database.

The naive version skips this and lets the database be the validator — a `NOT NULL` blows up somewhere deep, and the client gets a `500` with a stack trace.

A `500` is a bug.

A `400` is an answer.

We want answers. `parseOrThrow` turns zod's structured complaint into one clean `400`, and only a fully-typed object flows downstream:

```ts
const input = parseOrThrow(signupBody, req.body)
```

After this line, `req.body` — the `unknown` — is gone. Everything past it is typed.

---

## Step two, the signup path: two rows, or none

Mara is new. Signup has to create *two* things:

```
users      who Mara is        (id, email, emailVerified)
accounts   how Mara logs in   (provider='password', password_hash)
```

One identity. One credential. They only make sense together.

Here is the bad version:

```ts
await db.insert(users)...      // succeeds
await db.insert(accounts)...   // throws
```

Now there is a user with no way to log in. A ghost. And the email is taken, so Mara can't sign up again either.

The fix is a transaction — both rows commit, or neither does:

```ts
user = await db.transaction(async (tx) => {
  const [createdUser] = await tx.insert(users).values({ email, name }).returning()
  await tx.insert(accounts).values({ userId: createdUser.id, provider: 'password', passwordHash })
  return createdUser
})
```

All-or-nothing. No ghosts.

### The duplicate-email race

Two browser tabs. Mara double-clicks. Two identical signups arrive at almost the same instant.

The tempting guard is *check, then insert*:

```ts
const existing = await db.select()...where(eq(users.email, email))   // both see "no one"
if (existing) throw conflict()
await db.insert(users)...                                            // both insert
```

Both requests check *before* either inserts. Both see an empty table. Both proceed. Now there are two Maras.

This is a race, and you cannot win it with a check — there is always a gap between looking and acting.

So we don't look. We let the database's `UNIQUE` index on `email` be the judge. The first insert wins; the second violates the constraint and Postgres raises SQLSTATE **`23505`**. We catch exactly that:

```ts
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { code } = error as { code?: unknown }
  return code === '23505'
}
```

The constraint is atomic in a way a check-then-insert can never be. One Mara, always — even under a double-click.

---

## Step two, the login path: the leak in the error message

Now Mara comes back a week later and logs in. This is where it gets interesting.

A login can fail two ways:

    the email isn't registered
    the password is wrong

The obvious thing is to say which:

```
404  no account with that email
401  wrong password
```

That is **user enumeration**, and it is a real leak.

Watch what an attacker does with it. They don't know who banks here, or whose documents are on redline. So they probe:

    POST /auth/login  ceo@bigco.com  / anything   →  404   (not a user — move on)
    POST /auth/login  mara@work.test / anything   →  401   (a user! now brute-force her)

The `404` vs `401` *is* the answer to "does this person have an account here?" — which on a private tool is itself sensitive.

So login gives **one** answer for both cases:

```ts
const invalidCredentials = (): never => {
  throw unauthorized('invalid_credentials', 'Email or password is incorrect.')
}
```

"Email *or* password." Same status, same body, whether the email is unknown or the password is wrong. The response stops being an oracle.

### The leak you can't see: timing

Make the bodies identical and you've closed the *visible* leak. But there's a second one, and it hides in the clock.

Look at the honest two-branch code:

```
no such account   →  return immediately
wrong password    →  run argon2id verify (~50ms), then return
```

The bodies match. The *timing* doesn't.

A `401` that comes back in 2ms means "no such account." A `401` that takes 50ms means "real account, wrong password." The attacker times the response and reads the difference. Same leak, through a side door.

The fix is to make the missing-account path do the same expensive work:

```ts
if (account === undefined || account.passwordHash === null) {
  await verifyAgainstDecoy(input.password)   // burn ~50ms against a throwaway hash
  return invalidCredentials()
}
```

`verifyAgainstDecoy` runs a real argon2id verify against a hash of a dummy password. It always fails, but that's not the point — the point is it *takes the same time*. Now both paths cost ~50ms, and the clock says nothing.

(One subtlety the comment in the file calls out: the lookup is scoped to the **password** account, not the user. Mara could later add Google sign-in and have an account with no password hash at all. That path must look exactly like "no such email" — same decoy, same error — or *it* becomes the oracle.)

### What `null` would have cost us

Notice `account.passwordHash === null` sits in the *same* branch as "no account."

A Google-only user has a row, but no password. The naive code finds the row, calls `verify(null, password)`, and argon2id throws on a null hash — a `500`. Which, to an attacker, is a third distinct answer. Folding `null` into the decoy branch keeps the three cases — no email, no password, wrong password — indistinguishable.

---

## Step three: the cookie is the only thing that goes to the browser

Authentication succeeded. `password-auth.ts` asks `session.ts` for a fresh session and gets back a raw token (doc 01 covers what's stored: only the hash).

`cookies.ts` writes it:

```ts
reply.setCookie('redline_session', rawToken, {
  httpOnly: true,                              // JavaScript can't read it — XSS can't steal it
  secure: env.NODE_ENV === 'production',       // https-only in prod, but http in local dev
  sameSite: 'lax',                             // not sent on cross-site POSTs — blunts CSRF
  path: '/',
  expires: session.expiresAt,                  // dies exactly when the session does
})
```

Three flags, three different attacks.

`httpOnly` is for the cross-site **script** that tries to read `document.cookie`.

`sameSite: 'lax'` is for the cross-site **form** that tries to POST as Mara.

`secure` is for the network **eavesdropper** — off in dev only because there's no https there.

The raw token is the *only* secret that ever leaves the server. Everything else — the hash, the user row, the session row — stays put.

### Fixation, for free

Every login mints a **new** session id. We never adopt an id the client already has.

That kills session fixation: an attacker can't plant a known cookie in Mara's browser before she logs in and then ride it afterward, because the moment she logs in, that planted id is replaced by one she's never seen. Doc 01 has the full argument; the point here is that it costs us nothing — it's just what `createSession` already does on every login.

---

## Step four, later: the cookie becomes a user

Mara loads a page. The browser attaches the cookie. `GET /auth/me` runs:

```ts
const rawToken = req.cookies[SESSION_COOKIE_NAME]
if (rawToken === undefined) throw unauthorized(...)      // no cookie → not signed in

const active = await getSessionUser(rawToken)            // Redis → Postgres (doc 01)
if (active === null) throw unauthorized(...)             // expired or revoked → not signed in
```

This is the read-through cache from doc 01, used in anger. Cookie in, `userId` out, or a clean `401`.

It's the inverse of login. Login turned a `userId` into a token. `/me` turns the token back into a `userId`.

### Logout, and why it shrugs

```ts
if (rawToken !== undefined) await revokeSession(rawToken)   // kill the row + bust the cache
clearSessionCookie(reply)                                   // always
return reply.code(204).send()                               // always
```

Logout is **idempotent**. Log out twice, or log out with no session at all, and the answer is still `204`.

Why be so forgiving? Because logout is a *cleanup* action, and a cleanup action that can fail is a worse experience than one that can't. There's no security in making "log out when you're already logged out" an error. So it isn't one.

---

## When this is the wrong shape

The honest limits.

**The signup conflict still leaks.** Login is enumeration-proof; signup is not. A duplicate signup returns a distinct `409 email_taken` — which tells an attacker the email is registered. The real fix is a uniform *"check your email"* response that's the same whether the address is new or known, and that needs the email-send path (task A5). Until then the `409` stays, and there's a **skipped test** named for the gap so the suite reports it instead of pretending signup is safe. A green test you didn't write is not a guarantee.

**Timing equalization is approximate, not perfect.** The decoy verify makes the two paths *close*, not identical to the microsecond. A determined attacker with a clean network path and thousands of samples can still tease out a statistical difference. The strong mitigation against that isn't timing — it's the rate limiter (task A8), which caps how many samples they can take.

**This is session auth, not token auth.** Every `/me` pays a lookup (cached, but still). For a public API serving millions of stateless requests, a signed token that needs no lookup can be the better call. We chose sessions for instant revocation — doc 01 has that argument in full.

---

Validation makes the input trustworthy.

The service makes the *answer* trustworthy — same words, same timing, whether you exist or not.

The cookie makes the *next* request trustworthy.

Three steps, one request, and a login that tells an attacker nothing it doesn't have to.
