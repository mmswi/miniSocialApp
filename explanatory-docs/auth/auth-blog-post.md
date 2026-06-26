With all this fire and forget vibe coding around, it's time for some back to basics so here is a Claude generated authentication for my pet project (redline), but written in a maintainable and secure way that can be understood by humans. Find the feature [here](https://github.com/mmswi/miniSocialApp/tree/feature/auth). If you want to go step by step, go though each commit and look at the explanatory-documents folder as each commit is explained there.

This will take you through the auth *core* — sessions, login, account linking, password reset — it's built on top of a few vetted packages: [`argon2id`](https://www.npmjs.com/package/argon2id) for hashing, [`arctic`](https://www.npmjs.com/package/arctic) for the Google OAuth (Open Authorization) flow, [`BullMQ`](https://www.npmjs.com/package/bullmq) for the email queue.

So follow along by tracing one person through the whole machine.

Her name is Mara. She signs up with an email and a password. She logs in. She signs in with Google instead. She verifies her email. Weeks later she forgets her password and resets it. Eventually she links her Google login to her existing account.

Follow Mara, and the rest falls into place.

Two themes will keep coming back, so watch for them:

*   The interesting question is almost never *"can this be stolen?"* — usually the answer is yes. It is *"once it is stolen, what can the thief actually do, and can you turn it off?"*
    
*   The best defenses are not features you add. They are holes you never built. Several times in this post, a whole class of attack just *cannot happen* because of the shape of the thing — not because of a check.
    

Let's go.

* * *

## First: never store the password

Mara types `hunter2-but-longer`.

The naive version stores exactly that:

```plaintext
users
  email           password
  mara@work.test  hunter2-but-longer
```

This is bad.

The day that table leaks — and tables leak — every password is just sitting there. In plain text. Reusable on every other site Mara owns.

So we never store the password.

We store a one-way transformation of it. A hash.

A hash is a function you can run forwards but not backwards.

You can turn `hunter2-but-longer` into a hash.

You cannot turn the hash back into `hunter2-but-longer`.

That is the whole point.

```ts
// src/auth/password.ts
export const hashPassword = (plainPassword: string): Promise<string> =>
  hash(plainPassword, ARGON2_OPTIONS)
```

### Why argon2id, and not just any hash

Not every hash is safe for passwords.

`sha256(password)` is a hash (SHA-256, the Secure Hash Algorithm). It is also a terrible password hash.

Because it is *fast*. A modern GPU (Graphics Processing Unit) computes billions of sha256 per second. An attacker with your leaked table just tries billions of guesses until one matches.

A password hash should be *slow*. On purpose. Slow enough that a billion guesses becomes impractical.

`argon2id` is slow on purpose. It is also *memory-hard* — each guess must allocate real memory, which GPUs hate:

```ts
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB per hash
  timeCost: 2,
  parallelism: 1,
} as const
```

19 MiB per attempt. That is nothing for one honest login. It is a wall for an attacker doing billions.

### Why a fresh salt matters

Run the same password through the same hash twice and you would normally get the same output.

That is a problem.

If two users both pick `password123`, identical hashes give it away. And an attacker can precompute a giant table of `hash → password` once and reuse it against everyone — a "rainbow table."

A salt kills both.

A salt is a random value mixed into each hash, so the same password hashes differently every time.

argon2 generates a fresh random salt per call and stores it *inside* the hash string. You do not manage it. You can watch it work:

```ts
const first = await hashPassword('same input')
const second = await hashPassword('same input')
expect(first).not.toBe(second) // same password, different hash
```

Same input. Different output. Every time.

To check Mara's password at login, argon2 reads the salt and parameters back out of the stored hash and recomputes:

```ts
export const isPasswordCorrect = (storedHash: string, plainPassword: string): Promise<boolean> =>
  verify(storedHash, plainPassword)
```

The comparison is constant-time, so an attacker cannot learn the password by measuring how long the check takes.

So, where are we: the password runs through the server and never further than the login handler. A string goes in, a longer string comes out — the hash, with salt and params baked in. The hash gets stored; the password never does. A new salt is computed on every signup, a verify on every login. And what gets handed to the next step is a verified identity: *this really is Mara.*

* * *

## Second: the cookie is a key, so store the lock, not the key

Mara is who she says she is. Now the server needs to remember that on her *next* request.

It hands her a token. A long random string. She stores it in a cookie and sends it back every time.

```ts
// src/auth/tokens.ts
export const generateToken = (): string => randomBytes(32).toString('base64url')
```

32 random bytes. 256 bits of entropy. Nobody guesses that.

Here is the tempting, naive version:

```plaintext
sessions
  token                         userId
  k9f2...rawTokenInTheClear...  mara-uuid
```

Store the token. Mara sends it, you look it up, match found, she's in.

This is bad for the same reason plaintext passwords are bad.

That token *is* the key to Mara's account. Anyone holding it is Mara. And here you have copied every key into a database — the one thing most likely to leak.

So we do the same trick as passwords.

We store the *hash* of the token, not the token.

```ts
export const hashToken = (rawToken: string): string =>
  createHash('sha256').update(rawToken).digest('hex')
```

The raw token lives in exactly one place: Mara's cookie.

The database stores only `sha256(token)`:

```ts
// src/db/schema.ts — sessions.id is the HASH, not the raw token
id: text('id').primaryKey(), // sha256(rawToken)
```

Now think about a database leak.

The attacker gets a column of sha256 hashes.

To turn one back into a working cookie, they would have to reverse sha256. They cannot.

A leaked sessions table is a list of useless fingerprints.

This "store the hash, never the secret" move is the spine of this whole project. We will do it again for email-verification tokens and again for password-reset tokens. Same shape every time: the raw secret rides in the link or the cookie; the database keeps only its sha256.

### Why sha256 here, but argon2id for passwords

This looks like a contradiction. We just said sha256 is a bad password hash. Now we use it for tokens. On purpose.

The difference is what is being hashed.

A password is low-entropy. Humans pick `summer2024`. It is *guessable*, so the hash must be slow to make guessing expensive.

A token is 256 bits of pure randomness. It is *not guessable* — there is nothing to brute-force. So a fast hash is fine, and fast is good, because we verify tokens far more often than passwords.

Slow hash for the guessable thing.

Fast hash for the unguessable thing.

### Why a server session, and not a JWT

Mara has a cookie. The server checks it on every request. But what is actually *in* that cookie? There are two designs, and they differ in one thing: where the identity facts live, and how the server trusts the cookie each time.

Think of it as a coat-check ticket versus a signed ID card.

**Our design — a coat-check ticket.** Mara's cookie holds a random, meaningless string:

```typescript
k9f2x7q...   (43 random chars — says nothing on its own)
```

It is a ticket number. To learn who it belongs to, the server takes it to the back room and looks up what it points to:

```typescript
cookie = k9f2x7q...
↓  hash it: sha256(k9f2x7q...)
↓  look that hash up in the sessions table
Postgres:  sha256(k9f2...) → { userId: mara, expiresAt: ... }
```

The facts live in the database. The cookie is just a pointer to them.

**The alternative — a JWT (JSON Web Token), a signed ID card.** A JWT cookie holds the facts *themselves*, encoded, with a signature:

```typescript
eyJhbGci...  .  eyJ1c2VySWQiOiJtYXJhIn0  .  3aF9c...sig
   header              payload                signature
```

Base64-decode that middle part and it literally reads:

```typescript
{ "userId": "mara", "exp": 1699999999 }
```

Anyone can read it. A JWT is not encrypted — only *signed*. The server wrote `userId: mara` and stamped it with a signature only its secret can produce. So on each request the server does no lookup. It recomputes the signature — an HMAC, a Hash-based Message Authentication Code — over `header.payload` with its secret and checks it matches:

```typescript
cookie = eyJ...payload...sig
↓  HMAC(secret, header.payload) == sig ?
↓  yes → trust the payload. userId is mara.
(no database — the proof rides inside the card.)
```

The facts live inside the token. The server stores nothing per session, only its one secret.

One thing to be explicit about, because it is easy to conflate: hashing our session token at rest has *nothing* to do with JWT. We hash because we *store* the token, and a stored copy should be useless if the database leaks. A JWT is never stored — there is nothing to hash. Different concern.

```typescript
Ours:  random token  → STORE its hash, then look it up    (stateful)
JWT:   signed facts   → STORE nothing, just verify math     (stateless)
```

### But can't someone just steal the cookie?

Yes. And here is the honest part: a stolen cookie and a stolen JWT are *exactly* as bad as each other.

Both are *bearer tokens*. Whoever holds it, is Mara. Steal her session cookie, or steal her JWT, and the thief is Mara until something stops them.

Our design is not more theft-resistant. A stolen cookie is a stolen cookie.

```typescript
Can it be stolen?             ours: yes        JWT: yes      (identical)
Can you kill it once stolen?  ours: instantly  JWT: not until it expires
```

So the interesting question is not whether the token can be stolen — both can. It is whether, once it is stolen, you can turn it off. (Remember the theme.)

One word: revocation.

You might assume a JWT can be logged out. It mostly cannot.

A signed JWT is valid until it expires, because *nothing is checking a list*. The proof is self-contained. To kill it early you have to bolt a denylist back on — which quietly re-adds the database lookup you went stateless to avoid.

A server session is the opposite. Logout is a `DELETE`:

```typescript
// src/auth/session.ts
export const revokeSession = (rawToken: string): Promise<void> =>
  revokeBySessionId(hashToken(rawToken))
```

The row is gone. The next request with that cookie finds nothing. Mara is out. Instantly. Everywhere that token was used.

For a document-review tool where people share access and need to *really* be removed, instant revocation is worth one lookup.

Here is the honest tradeoff, stated once so I don't have to keep restating it: if you were building a fleet of stateless services that must verify identity with zero shared database — many microservices, edge functions — a signed JWT earns its keep, and you accept weaker logout. We are a single app with one Postgres and one Redis. Instant revocation matters more than shaving a lookup. So: server sessions. Pick the one that fits.

* * *

## Third: Redis sits in front, but Postgres is the truth

One lookup per request sounds cheap. At scale it is not — it is a database round-trip on *every* call, including every WebSocket message later.

So we cache it.

But caching identity is dangerous if you do it naively.

The naive version: store sessions *only* in Redis.

Fast. Also fragile. Redis is memory; restart it and everyone is logged out. And it makes revocation murky — which copy is the truth?

We avoid that by being strict about one thing:

```typescript
Postgres is the source of truth.
Redis is only a fast shortcut in front of it.
```

This is a read-through cache. The flow:

```typescript
request with cookie
↓
check Redis for this session          (fast path, in-memory)
↓ miss
read Postgres                          (source of truth)
↓ found + not expired
copy it into Redis with a short TTL    (time-to-live, so the next read is fast)
↓
return the user
```

```typescript
// src/auth/session.ts — the miss path repopulates the cache
const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
// ...
await redis.set(key, JSON.stringify(cacheValue), 'EX', ttl)
```

If Redis dies, nothing breaks. Every request just becomes a Postgres read again. Slower. Not broken.

### The one honest tradeoff: revoke-all vs the cache

Single logout is instant. We hold the raw token, so we delete the row *and* delete that exact Redis key:

```typescript
const revokeBySessionId = async (sessionId: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
  await redis.del(cacheKey(sessionId))
}
```

"Log out everywhere" is different. We delete all of Mara's rows in Postgres immediately. But we do not hold every raw token, so we cannot bust every Redis key by hand.

A session cached a second before the revoke could still validate — until its cache entry expires.

So we keep that window short on purpose:

```typescript
const CACHE_TTL_SECONDS = 60 // bounds how long a cached session can outlive a revoke-all
```

Sixty seconds. That is the tradeoff, stated plainly: single logout is instant; logout-everywhere is instant in Postgres and lags at most a minute in cache. We chose that over tracking every session key per user. For this app, a one-minute tail on "log out all devices" is fine. If it were a bank, it would not be. (This sixty-second lag comes back later, when a password reset tries to log out a thief.)

* * *

## Fourth: a free defense you get just from the shape

There is a subtle attack called session fixation.

The attacker plants a known session id on a victim *before* they log in, then rides that same id after the victim authenticates.

It only works if the session id stays the same across the login boundary.

Ours cannot.

We do not have a session *before* login to reuse. We *mint a brand-new one* at the moment login succeeds:

```typescript
// createSession runs on successful login — fresh random token every time
const rawToken = generateToken()
```

A fresh token on every login means there is no pre-login id to fix. The defense falls out of the design. We did not add a feature for it; we just never created the hole.

The good ones are often like that. The vulnerability is the thing you *didn't* build.

* * *

## Assembling it: one request, four files, one round trip

We have the parts. Now the assembly.

Mara clicks **Sign in**. Between that click and *Welcome back* there is one HTTP request, four files, and exactly one round trip.

Everything here runs on the **server**. The browser's whole job is to send a little JSON and, later, to hold a cookie.

Four steps, always in this order: **validate → authenticate → mint → set cookie.**

Each hands the next a smaller, more-trusted thing. The body comes in as `unknown`. The validator turns it into a typed `{ email, password }`. The service turns that into a `userId`. The session turns the `userId` into a raw token. The cookie carries the token back to the browser.

The rest of this section is *why each step is shaped the way it is.*

### Step one: the body is guilty until proven typed

The request body is whatever the client sent. It could be anything.

So the first thing the route does is refuse to trust it:

```typescript
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

We want answers. After `parseOrThrow(signupBody, req.body)`, the `unknown` is gone. Everything past it is typed.

### Step two, signup: two rows, or none

Mara is new. Signup has to create *two* things:

```typescript
users      who Mara is        (id, email, emailVerified)
accounts   how Mara logs in   (provider='password', password_hash)
```

One identity. One credential. They only make sense together.

The bad version:

```typescript
await db.insert(users)...      // succeeds
await db.insert(accounts)...   // throws
```

Now there is a user with no way to log in. A ghost. And the email is taken, so Mara can't sign up again either.

The fix is a transaction — both rows commit, or neither does:

```typescript
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

```typescript
const existing = await db.select()...where(eq(users.email, email))   // both see "no one"
if (existing) throw conflict()
await db.insert(users)...                                            // both insert
```

Both requests check *before* either inserts. Both see an empty table. Both proceed. Now there are two Maras.

This is a race, and you cannot win it with a check — there is always a gap between looking and acting.

So we don't look. We let the database's `UNIQUE` index on `email` be the judge. The first insert wins; the second violates the constraint and Postgres raises SQLSTATE `23505` — the SQL (Structured Query Language) standard's code for a unique-constraint violation. We catch exactly that:

```typescript
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { code } = error as { code?: unknown }
  return code === '23505'
}
```

The constraint is atomic in a way a check-then-insert can never be. One Mara, always — even under a double-click.

(What happens *after* we catch that `23505` is a story in itself — a duplicate signup is a privacy leak waiting to happen. Hold that thought; we close it once the email channel exists.)

### Step three: the cookie is the only thing that goes to the browser

Authentication succeeded. We mint a session and write the cookie:

```typescript
reply.setCookie('redline_session', rawToken, {
  httpOnly: true,                              // JavaScript can't read it — XSS (Cross-Site Scripting) can't steal it
  secure: env.NODE_ENV === 'production',       // https-only in prod, but http in local dev
  sameSite: 'lax',                             // not sent on cross-site POSTs — blunts CSRF (Cross-Site Request Forgery)
  path: '/',
  expires: session.expiresAt,                  // dies exactly when the session does
})
```

Three flags, three different attacks.

`httpOnly` is for the cross-site **script** that tries to read `document.cookie`.

`sameSite: 'lax'` is for the cross-site **form** that tries to POST as Mara.

`secure` is for the network **eavesdropper** — off in dev only because there's no https there.

The raw token is the *only* secret that ever leaves the server. Everything else — the hash, the user row, the session row — stays put.

### Step four, later: the cookie becomes a user

Mara loads a page. The browser attaches the cookie. `GET /auth/me` runs:

```typescript
const rawToken = req.cookies[SESSION_COOKIE_NAME]
if (rawToken === undefined) throw unauthorized(...)      // no cookie → not signed in

const active = await getSessionUser(rawToken)            // Redis → Postgres read-through
if (active === null) throw unauthorized(...)             // expired or revoked → not signed in
```

It is the inverse of login. Login turned a `userId` into a token. `/me` turns the token back into a `userId`.

And logout *shrugs*:

```typescript
if (rawToken !== undefined) await revokeSession(rawToken)   // kill the row + bust the cache
clearSessionCookie(reply)                                   // always
return reply.code(204).send()                               // always
```

Logout is **idempotent**. Log out twice, or log out with no session at all, and the answer is still `204`. Logout is a *cleanup* action, and a cleanup action that can fail is a worse experience than one that can't. There's no security in making "log out when you're already logged out" an error. So it isn't one.

* * *

## The leak hiding in the error message

Now Mara comes back a week later and logs in. This is where it gets interesting.

A login can fail two ways:

```typescript
the email isn't registered
the password is wrong
```

The obvious thing is to say which:

```typescript
404  no account with that email
401  wrong password
```

That is **user enumeration**, and it is a real leak.

Watch what an attacker does with it. They don't know who banks here, or whose documents are on redline. So they probe:

```typescript
POST /auth/login  ceo@bigco.com  / anything   →  404   (not a user — move on)
POST /auth/login  mara@work.test / anything   →  401   (a user! now brute-force her)
```

The `404` vs `401` *is* the answer to "does this person have an account here?" — which on a private tool is itself sensitive.

So login gives **one** answer for both cases:

```typescript
const invalidCredentials = (): never => {
  throw unauthorized('invalid_credentials', 'Email or password is incorrect.')
}
```

"Email *or* password." Same status, same body, whether the email is unknown or the password is wrong. The response stops being an oracle.

### The leak you can't see: timing

Make the bodies identical and you've closed the *visible* leak. But there's a second one, and it hides in the clock.

Look at the honest two-branch code:

```plaintext
no such account   →  return immediately
wrong password    →  run argon2id verify (~50ms), then return
```

The bodies match. The *timing* doesn't.

A `401` that comes back in 2ms means "no such account." A `401` that takes 50ms means "real account, wrong password." The attacker times the response and reads the difference. Same leak, through a side door.

The fix is to make the missing-account path do the same expensive work:

```typescript
if (account === undefined || account.passwordHash === null) {
  await verifyAgainstDecoy(input.password)   // burn ~50ms against a throwaway hash
  return invalidCredentials()
}
```

`verifyAgainstDecoy` runs a real argon2id verify against a hash of a dummy password. It always fails, but that's not the point — the point is it *takes the same time*. Now both paths cost ~50ms, and the clock says nothing.

This **timing-equalization with a decoy hash** is a move we'll make again at signup. Burn the same work on the path that has no real work to do, so the duration carries no signal.

Notice `account.passwordHash === null` sits in the *same* branch as "no account." A Google-only user has a row, but no password. The naive code finds the row, calls `verify(null, password)`, and argon2id throws on a null hash — a `500`. Which, to an attacker, is a third distinct answer. Folding `null` into the decoy branch keeps the three cases — no email, no password, wrong password — indistinguishable.

One honest limit while we're here: timing equalization is *approximate*, not perfect. A determined attacker with a clean network path and thousands of samples can still tease out a statistical difference. The strong mitigation against that isn't timing — it's the rate limiter, which caps how many samples they can take. We build that later.

* * *

## Google sign-in, and the link you must not make

There are three parties in this story, not two.

Mara's browser. Our server. And Google.

Password login was a conversation between two of them — the browser tells our server a secret, our server checks it. Google sign-in is a *flow* between all three, where our server never sees Mara's Google password at all.

The interesting part isn't the flow. arctic handles the steps. The interesting part is the very last decision: Mara shows up with a verified Google email, and there's *already an account here with that email*. Do we merge them?

Get that wrong and you hand one person's account to another.

Let's earn our way to that decision.

### The base flow: what actually happens

Forget security for a minute and just watch Mara sign in.

The goal is simple: **Google vouches for Mara to us, and we never see her Google password.**

But Google can't call our server out of the blue. The only thing that touches *both* Google and our server is **Mara's browser**, bouncing between them. So the whole flow is built out of browser redirects.

Three beats:

```plaintext
1. Mara clicks "Sign in with Google."
   Our server bounces her browser over to Google.
   ↓
2. Mara logs in at Google and approves.
   Google bounces her browser back to us — carrying a code.
   ↓
3. Our server takes that code and calls Google directly:
   "who does this code stand for?"
   Google answers with Mara's identity.
```

That `code` is the pivot of the whole thing.

It's a **one-time ticket** Google hands out that means *"a real user just approved."* Step 3 redeems the ticket for Mara's actual identity — and that redemption is a **server-to-server** call, our server straight to Google, with no browser in the middle.

That's the entire flow. It works. It's also broken in two ways — and the two cookies we set on the way out (`state` and `code_verifier`, which the code spells `codeVerifier`) are the two patches. Everything else in this section is just those two patches.

```plaintext
OUT     (our redirect  → Google):  state + code_challenge
BACK    (Google        → us):      code + state   (state echoed)
DIRECT  (our server    → Google):  code + code_verifier
```

`state` makes a round trip. `code` comes back. `code_verifier` only ever leaves at the very end, and never through the browser. The two patches below are just *why* each value travels the way it does.

### The same flow, with real values

Names blur together. Values stick. So let's give all four concrete (made-up but realistic) values and watch where each one physically *is* at every hop.

```plaintext
state          = "x7Kp9w"             — random, WE make it
code_verifier  = "tZ7n_K2pQ9xR4mL8"   — random secret, WE make it
code_challenge = "E9f2b7c1aZ…"        — SHA-256 of the verifier, WE make it
code           = (doesn't exist yet)  — GOOGLE mints it in Hop 2
```

Three of the four exist *before we ever contact Google* — we make them. `code` is the odd one out. This is the bit that trips people up: **we never send Google a** `code`**.** We send `state` and `code_challenge`; Google hands a `code` *back*.

**Hop 1 — we send Mara's browser to Google.**

Not to our callback (that's the trip *back*, in Hop 3). We build a URL to *Google's* sign-in endpoint and redirect her there:

```plaintext
302 → https://accounts.google.com/o/oauth2/v2/auth
        ?client_id=redline.apps.googleusercontent.com
        &redirect_uri=https://redline.app/auth/google/callback
        &response_type=code
        &scope=openid email profile
        &state=x7Kp9w               ← in the URL
        &code_challenge=E9f2b7c1aZ…  ← in the URL (the HASH)
        &code_challenge_method=S256
```

In that *same response*, we set two cookies on Mara's browser:

```plaintext
Set-Cookie: g_state=x7Kp9w;              HttpOnly
Set-Cookie: g_verifier=tZ7n_K2pQ9xR4mL8; HttpOnly
```

So right now, here's where everything is:

```plaintext
URL → Google (public):    state, code_challenge(the hash)
Mara's cookies (httpOnly): state, code_verifier(the secret for that hash)
```

`code_verifier` (the secret) sits in a cookie and appears in **no URL**. Only its hash travelled. That one split is all of **PKCE** (**Proof Key for Code Exchange** — is pronounced "**pixie**.").

**Hop 2 — Google's turn.**

Google shows Mara the consent screen; she clicks Allow. Google now:

```plaintext
holds  state          = x7Kp9w        → will echo it back
files  code_challenge = E9f2b7c1aZ…   → pinned to the code below
mints  code           = 4/0AfJ…       → a fresh one-time ticket
```

What Google never received: `code_verifier`. It only has the hash.

**Hop 3 — Google sends Mara's browser back. *This* is the callback:**

```plaintext
302 → https://redline.app/auth/google/callback
        ?code=4/0AfJ…       ← Google's ticket
        &state=x7Kp9w       ← our state, echoed back unchanged
```

Mara's browser still carries the Hop-1 cookies, so our server now holds both:

```plaintext
from the URL:     code = 4/0AfJ…     state = x7Kp9w
from the cookies: verifier = tZ7n…   state = x7Kp9w
```

**Gate 1 — our server checks:**

```plaintext
state in URL (x7Kp9w)  ===  state in cookie (x7Kp9w) ?
yes → this callback answers the sign-in WE started. Continue.
```

**Hop 4 — we redeem the code, server-to-server (no browser):**

```plaintext
POST https://oauth2.googleapis.com/token
        code=4/0AfJ…
        code_verifier=tZ7n_K2pQ9xR4mL8   ← secret's first time out
        client_id=…  client_secret=…
        grant_type=authorization_code
```

**Gate 2 — Google checks:**

```plaintext
SHA-256("tZ7n_K2pQ9xR4mL8")          = E9f2b7c1aZ…   (recomputed now)
the challenge Google filed in Hop 2  = E9f2b7c1aZ…
match → whoever holds the verifier started this. Here's the id token.
```

Where each value lived, all at once:

With those values in hand, both attacks below are easy to see:

```plaintext
Thief reads the Hop-1 URL → gets state=x7Kp9w, code_challenge=E9f2b7c1aZ…
   state: useless without Mara's httpOnly cookie (can't be written).
   challenge: a hash — won't reverse to tZ7n_K2pQ9xR4mL8.

Thief steals code=4/0AfJ… from a leaked Hop-3 URL → stuck at Gate 2:
   it demands code_verifier=tZ7n_K2pQ9xR4mL8, which only ever lived
   in Mara's httpOnly cookie and never rode any URL.
```

The next two sections are just those two attacks, spelled out.

### `state`: proving the callback answers the request we started

Look at step 2 again. Google sends Mara's browser back to us with a `code` in the URL (Uniform Resource Locator):

```typescript
GET /auth/google/callback?code=…
```

The hole: *anyone* can point Mara's browser at that callback URL.

So an attacker starts *their own* Google sign-in and gets a valid `code` for *their* account. They don't redeem it. They trick Mara's browser into hitting our callback with *their* code:

```typescript
/auth/google/callback?code=THE-ATTACKERS-CODE
```

If our server redeems whatever `code` shows up, it logs Mara into **the attacker's account** — and everything she uploads or comments now sits in an account the attacker can read. (This is CSRF — Cross-Site Request Forgery — a forged request riding in on the victim's browser.)

The fix: refuse any callback that can't prove it's finishing *the sign-in we started for this browser*. That is `state`'s whole job:

```ts
if (query.data.state !== cookieState) {
  throw badRequest('oauth_state_mismatch', 'Google sign-in could not be verified.')
}
```

The attacker's forged callback carries the attacker's state — but Mara's browser never received a cookie for *that* sign-in. The two don't match. Rejected.

`state` is the thread tying *who started this* to *who's finishing it*.

### PKCE: making a stolen `code` worthless

`state` proved the callback is ours. PKCE protects the `code` itself.

Remember how the `code` travels: Google → browser → us, sitting in a URL. **URLs leak** — server logs, browser history, a shoulder-surfed address bar. So assume the `code` *can* be stolen in transit. If a stolen `code` were enough to redeem, the whole thing falls over.

So redeeming a `code` has to require a **second thing** — a secret that only the browser which *started* this sign-in could hold. That second thing is `code_verifier`.

The trick is that there are two different roads to Google — one *through* Mara's browser, one a direct server-to-server HTTPS (HTTP Secure) call:

```plaintext
Front channel — through the browser (redirect URLs — these leak)
Back channel  — our server → Google directly (never via browser)
```

PKCE keeps the secret off the leaky road. We generate the secret, send Google only a *hash* of it up front, and reveal the secret itself only on the private road, at the very end:

```plaintext
code_verifier   = a long random secret   (stays in our cookie)
code_challenge  = SHA-256(code_verifier) (just a hash — shareable)
```

The verifier is the key. The challenge is a *photo of the key's shape* — enough to check a match, not enough to cut a copy.

**Up front**, as the sign-in starts, we compute the challenge locally and put it in the redirect URL:

```typescript
const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES)
```

That URL carries the **challenge**, never the verifier. Mara's browser delivers it to Google (front channel), and Google files it against this request before handing back a `code`.

**At the end**, to redeem the `code`, our server makes its one direct call — sending the **verifier** for the first and only time:

```typescript
const tokens = await google.validateAuthorizationCode(code, codeVerifier)
```

This is the back channel. Google computes `SHA-256(verifier)` and checks it equals the challenge it filed earlier. Match → tokens. Mismatch → rejected.

So the two halves reach Google by two different roads, and only the harmless one ever rides the leaky channel:

```plaintext
challenge (hash)    → browser → Google   — up front
verifier  (secret)  → server  → Google   — only at the very end
```

Now the attacker who scraped the `code` from a leaked URL tries to redeem it. Google asks for the verifier:

```plaintext
Not in a URL   — it was never put in one.
Not in reach   — the cookie is httpOnly, on Mara's machine.
Not reversible — SHA-256 doesn't run backwards.
```

No verifier, no exchange. The stolen `code` is dead. A code without its verifier is a key without its cut.

### What comes back: an id token, not a password

Look closer at that **id token**. It's a JWT whose payload is a small bag of facts about Mara, signed by Google:

```typescript
{ "sub": "11029...", "email": "mara@work.test", "email_verified": true, "name": "Mara" }
```

`sub` is Google's permanent, unique id for Mara — stable even if she changes her email. That's what we store as her Google identity, not the email.

We got this token directly from Google's token endpoint, over TLS (Transport Layer Security). So we *decode* the claims rather than re-verifying the signature — the secure channel already proved where it came from:

```typescript
rawClaims = decodeIdToken(tokens.idToken())
```

Then we parse it strictly. `email_verified` must be a real boolean. If Google ever sent something surprising, the parse fails and the whole sign-in fails — closed:

```typescript
const googleIdTokenClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  // …
})
```

**Fail-closed** is the rule whenever the question is "is this email proven?" A wrong "no" is an inconvenience. A wrong "yes" is the bug in the next section.

### The decision: create, link, or refuse

Now we have a verified identity in hand. Three cases.

**Case 1 — a returning Google user.** The `sub` already maps to one of our users. Found it, open a session, done. The common path.

**Case 3 — a brand-new person.** No Google identity, and no local account owns this email. Create the user and the Google credential together, in one transaction. Google already verified the email, so the new user inherits that.

I'm skipping Case 2 on purpose. Case 2 is the whole point.

### Case 2: the email is already taken

Mara signed up weeks ago with `mara@work.test` and a password. Today she clicks "Sign in with Google," and her Google email is the *same address*.

No Google identity yet. But a user row already owns `mara@work.test`.

The tempting move:

> Google says the email is verified, and it matches. Link them. Log her in.

Here's why that's a door you must not open.

`mara@work.test` being in our `users` table does **not** mean Mara put it there.

Our signup lets anyone type any email. It doesn't prove ownership. So picture this, before Mara ever shows up:

```plaintext
1. Attacker signs up with email = mara@work.test, password = (their own).
   Our users table now has a row for mara@work.test. emailVerified = false.
   (It was never proven — nobody clicked a link.)

2. The real Mara later clicks "Sign in with Google."
   Google says: mara@work.test, email_verified = true. It matches!

3. Naive rule auto-links Google to that existing row.
   Mara is now sharing an account with the attacker —
   who still knows the password.
```

The attacker is now inside Mara's account. They planted the email; the verified Google login walked right into the trap.

So matching-and-Google-verified is **not enough**. The fix is to demand proof from **both sides**:

```ts
const bothEmailsVerified = claims.emailVerified && existingUser.emailVerified
if (!bothEmailsVerified) {
  throw conflict('account_exists', 'An account with this email already exists. Sign in with your password to link Google.')
}
```

Google-verified *and* the local account already verified. The attacker's planted row was never verified, so the guard refuses to link and the takeover never happens.

You might assume "verified email matches" is the linking rule. It is half of it. The other half is *whose* verified — and a local row you can't trust doesn't count.

There's a catch, and it's worth being honest about: when this guard first landed, *nothing could produce a verified local account.* There was no way to verify a password account yet, so every "I have a password account, now I'm adding Google" attempt hit the `409`. The guard was correct, but in practice refuse-only.

That's fine. Refusing safely while the verified state is unreachable beats linking unsafely. And it's exactly the gap the next section fills — the guard doesn't move; the world catches up to it.

A few limits worth naming before we move on. This is **one provider**: the whole module is Google-shaped — one `sub`, one id token, Google's verified-email semantics. A second provider (GitHub) doesn't hand you a reliable `email_verified`, and the linking rule would change. The refusal is a JSON `409` — fine for a backend, but a browser mid-redirect deserves a real "you already have an account, here's how to link" page; that's frontend work. And decode-don't-verify rests on one assumption: the id token came straight from Google over TLS. It does here. Accept an id token from somewhere you didn't fetch yourself and you must verify the signature.

* * *

## Email verification: a claim is not a proof

Signup asked Mara for an email. It never asked the email whether it wanted Mara.

Anyone can type anyone's address into a signup form. A row in our `users` table that reads `mara@work.test` is a *claim* — "someone said they own this" — not a *proof*. We just saw the damage when you treat the claim as proof: an attacker registers a victim's address, and a later real Google login links straight into the attacker's account.

Verification turns the claim into a proof. The mechanism is one link, clicked once.

`users.emailVerified` is a single boolean. The job of this whole piece is to make sure it only ever flips to `true` for someone who can actually read mail at that address.

So we send something to the address and check whether it comes back. That something is a token — and it's the session token in a different hat. The moves are identical to the ones we already built:

```plaintext
generate a long random token   — 32 bytes, unguessable
store only its sha256 hash      — the id column of email_verification_tokens
put the RAW token in the link   — the only copy that leaves the server
give it an expiry               — 24 hours
```

```typescript
const rawToken = generateToken()
await db.insert(emailVerificationTokens).values({ id: hashToken(rawToken), userId, expiresAt })
```

The raw token rides in the email. The database keeps only `sha256(rawToken)`. A leak of that table hands an attacker a column of hashes that open nothing — the same reason session tokens are stored hashed.

The bad version makes the point: email a link like `?verify=user_42`. Now anyone verifies anyone by editing the URL. The token is long and random *because* it has to be the proof — unguessable and unforgeable, not just an id.

### The flow

```plaintext
Signup                                                          (server)
↓
issue token: store sha256(token), email the raw token in a link (server)
↓
Mara opens her inbox and clicks the link                        (client)
↓
GET /auth/verify?token=…                                        (server)
↓
sha256 the token, look it up, check expiry
↓
flip emailVerified = true, delete the token, redirect to the app
```

Server-side at every step except the click. The only thing stored is the hash, plus the flag once it flips.

### Single-use, and why the row is deleted

```typescript
await db.transaction(async (tx) => {
  await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId))
  await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, id))
})
```

The flip and the delete commit together. A token that already verified someone no longer exists, so the same link can't be replayed into a second verification.

That deletion shapes the error messages. A verify fails two ways the user can tell apart:

```plaintext
expired   — the link is older than 24 hours
invalid   — unknown, or already used
```

It cannot separate "already used" from "never existed" — a used token was *deleted*, so there's no row left to distinguish it. Both return `invalid_verification_token`. Keeping a tombstone that said "this one was used" would be an oracle: a way to probe which tokens once existed. Forgetting is safer.

### What this makes possible

The flag isn't decoration.

The Google guard from the last section becomes *reachable*. A verified password account can now merge with a matching verified Google login — the exact precondition the takeover guard was waiting on. The guard didn't change; verification is what made its success path possible.

And a **uniform signup response** becomes possible — answering "check your email" identically whether the address is new or already registered, moving the real signal into the inbox instead of the HTTP status. That's the next section, and it's how we finally close the duplicate-signup leak I flagged earlier.

### When this is the wrong shape

**A GET that changes state will be clicked by robots.** The verify link is a plain URL in an email, so the browser fetches it with a GET — and so does every link scanner that touches the message first: corporate mail filters, antivirus, chat-app link previews. That bot's GET hits `/auth/verify`, flips the flag, and *deletes the token* before Mara clicks. She ends up verified, but her real click then shows "invalid or already used." It's confusing, not a hole — the scanner can only verify the address it was already trusted to handle. The standard fix is a two-step page: the GET renders a "Confirm" button and a POST does the mutation, which scanners don't follow. That's frontend work, and the wart is inherent to a link that both arrives by GET and changes state.

**Unverified users can still log in.** We don't gate basic access on verification; an unverified Mara can sign in and look around. Verification gates *linking*, not the front door. That's a policy choice — an app moving money would gate more.

A token sent is a question: *can you read this?* A token returned is the answer: *yes.* The flag it flips is the difference between a claim and a proof.

* * *

## How mail actually leaves the process

Twice now I've said "we email the user." Never *how* an email leaves the process and lands in an inbox.

This is that part. And the interesting thing is that "send an email" means three completely different things depending on where the code is running.

### Start with the bad version

The obvious way to send mail is to call the provider right where you need it:

```typescript
// in the signup handler
await resend.emails.send({ from, to, subject, html })
```

Three things break.

Your **tests** now hit the network — or you mock the Resend SDK (Software Development Kit) in every test that touches signup.

A **slow provider** stalls the signup request, because the user is waiting on an API (Application Programming Interface) call to a third party.

And you've **welded** the signup flow to one vendor. Swap Resend for SES (Amazon's Simple Email Service) and you edit every call site.

The fix is a seam. One function, `sendEmail`, that every caller uses — and behind it, a transport chosen by environment.

### The seam

Everything that sends mail calls exactly this:

```ts
sendEmail({ to, subject, text })
```

A recipient, a subject, a body. No provider, no SMTP (Simple Mail Transfer Protocol), no SDK in sight.

Who calls it? Never the route directly. Two small **templates** do, each owning one message:

```typescript
// src/auth/verify.ts — these decide WHAT to say
sendVerificationEmail(to, rawToken)   // "Confirm your email: <APP_URL>/auth/verify?token=…"
sendAccountExistsEmail(to)            // "You already have an account — just log in."
```

So the layers are clean:

```plaintext
signupWithPassword        WHEN to send
  ↓
sendVerificationEmail     WHAT to say    (subject + body + the link)
  ↓
sendEmail                 WHERE to send  (picks the transport)
  ↓
the transport             HOW it travels (memory, or an SMTP socket)
```

Each layer knows only the one below it. The template doesn't know about SMTP. The route doesn't know about either.

### Three transports, chosen by NODE\_ENV

Here is the part that surprises people. `sendEmail` does three different things, and the only input that decides which is `NODE_ENV`:

```plaintext
sendEmail(message)
├─ test         → push onto sentEmails[]        (no network at all)
├─ development  → SMTP → Mailpit                (localhost:1025, viewable at :8025)
└─ production   → SMTP → a real provider        (SMTP_HOST / USER / PASS from env)
```

```typescript
export const sendEmail = async (message) => {
  if (env.NODE_ENV === 'test') {
    sentEmails.push(message)   // an array in memory
    return
  }
  await mailer().sendMail({ from: env.EMAIL_FROM, to: message.to, ... })
}
```

**Under test, there is no email.** `sentEmails` is a plain array. A test signs up, then reads the array back to find the link that was "sent":

```typescript
const link = sentEmails.find((m) => m.to === email)?.text.match(/token=(\S+)/)?.[1]
```

That's how the verification end-to-end test gets the token without a mail server. No network, no flake, instant.

**Under dev and prod, it's the same code** — `mailer().sendMail(...)` over SMTP. The *only* difference is where the socket points, and that's pure config, not code. Dev points at [**Mailpit**](https://hub.docker.com/r/axllent/mailpit): a docker container that speaks SMTP like a real server but never delivers anything — it just *catches* every message and shows it at `http://localhost:8025`. You sign up, switch tabs, and there's the verification email — click the link, you're verified. A real round trip, nothing leaving your laptop. Prod points those same env vars at a provider that *does* deliver.

### The connection is a singleton

`mailer()` doesn't build a new connection per email:

```ts
const mailer = () => {
  globalForMailer.mailer ??= createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, ... })
  return globalForMailer.mailer
}
```

One transporter per process, cached on `globalThis` so dev hot-reload reuses it instead of leaking a socket each reload — the same pattern as the DB (database) pool and the Redis client. It's also lazy: `createTransport` opens no socket; the connection happens on the first `sendMail`. So importing the module costs nothing — the import stays side-effect-free even though the module owns a connection. (Remember this singleton-on-globalThis shape; the queue uses it next.)

### A failed send must not fail the signup

One rule the pipeline has to honor: the user row is already committed by the time we send. If the mail throws, the signup must still succeed.

Two reasons. First, it would be absurd to destroy an account because a third-party mail API hiccupped. Second — and sharper — on the duplicate path a thrown send would change the response, and that would reopen the enumeration oracle we're about to close: success returns `200`, a throw returns `500`, and now new-vs-taken is distinguishable again.

So both sends go through a best-effort wrapper:

```ts
const sendSignupEmail = async (send) => {
  try { await send() }
  catch (error) { console.error('[signup] email failed to send; signup still succeeds', error) }
}
```

Both call sites use it identically, so their failure behavior can't diverge. `sendEmail` itself still throws honestly; it's the *signup flow* that chooses to swallow, because only it knows the row is already there.

### The wart this leaves

The send is **synchronous**. Mara's signup waits for `sendMail` to finish. Mailpit is instant and the fail-soft wrapper means a slow provider won't *fail* the request — but it can still *slow* it.

Worse, look again at what fail-soft actually does on a failure: it logs and moves on. Signup succeeds — good. But the **verification link is now gone.** One attempt, it failed, nothing tries again. Mara sits at "check your email" forever, staring at an inbox that will never receive anything.

That wrapper protected the *signup* by sacrificing the *email*. The fix is a queue. That's the next section.

* * *

## The email queue: a failed send must not lose the link

The whole idea fits in one swap. Instead of *sending* the email at signup time, *enqueue* it:

```plaintext
BEFORE   signup → sendEmail() → SMTP → (provider hiccups) → log + drop. Link lost.

AFTER    signup → enqueueEmail() → Redis. Returns in ~1ms.
                                     ↓
              worker → sendEmail() → SMTP → (hiccups) → BullMQ retries with backoff
                                     ↓ (eventually succeeds)
                                   delivered
```

Two properties fall out.

**Fast.** `enqueueEmail` touches only Redis (local, ~1ms) and returns. Signup no longer waits on a third party at all — not even the instant Mailpit case.

**Durable.** The job lives in Redis. If the first SMTP attempt fails, BullMQ re-runs it later — 5 attempts, exponential backoff. A transient provider outage costs minutes of delay, not a lost account.

### The producer side

`enqueueEmail` is the new seam the app calls. It replaces the direct `sendEmail` at the two template sites:

```ts
export const enqueueEmail = async (message) => {
  if (env.NODE_ENV === 'test') {
    await sendEmail(message)   // no worker under test — deliver inline (see below)
    return
  }
  await emailQueue().add(EMAIL_JOB_NAME, message)
}
```

`emailQueue()` is the same singleton pattern as the DB pool, the Redis client, and the mailer — one `Queue` per process, cached on `globalThis`, built lazily so the import stays free. The job payload is just the `{ to, subject, text }` from before; the template still decides *what* to say, the queue is purely *how it travels now.*

### The consumer side — and the one bug that matters

The worker drains the queue and delivers each job. The handler is three lines, and one of them is load-bearing:

```ts
export const createEmailJobHandler =
  (deliver) =>
  async (job) => {
    await deliver(job.data)   // throws → BullMQ retries. Do NOT catch here.
  }
```

Here is the trap. Your instinct, fresh off the fail-soft wrapper, is to wrap this in a try/catch — "emails shouldn't crash things." **That instinct breaks the entire feature.**

A BullMQ job is retried *only if it rejects*. If the handler catches the SMTP error and returns normally, BullMQ sees a job that **completed successfully**, drops it, and never retries. You'd have built a queue that swallows failures exactly as silently as the thing it replaced — except now it *looks* robust. The whole point is that `sendEmail` throws, and that throw must travel all the way up to BullMQ.

So fail-soft does NOT live in the worker. It moved to wrap only the *enqueue*:

```plaintext
producer (signup):   try { await enqueueEmail(...) } catch { log }   ← guards a rare Redis hiccup
worker (delivery):   await deliver(job.data)                          ← MUST reject so BullMQ retries
```

The producer still can't fail signup or reopen the enumeration oracle — but now it's guarding a local Redis write (almost never fails), not a flaky third-party SMTP call. The flaky part got moved to where retries live.

This is the one thing worth a unit test, and it's the cheapest test in the suite:

```ts
const handle = createEmailJobHandler(async () => { throw new Error('smtp down') })
await expect(handle({ data: message })).rejects.toThrow('smtp down')   // proves: rejects → will retry
```

Delivery is *injected* into the handler precisely so this test can drive a failure without a real mail server. We don't test BullMQ's backoff — that's the library's job. We test our wiring: a failed delivery rejects.

### Test mode still has no worker

Under the test runner there's no worker process running, so a queued job would sit in Redis forever and the auth end-to-end test — which reads the verification link back out of that in-memory `sentEmails` array — would hang.

So `enqueueEmail` keeps the same `NODE_ENV` fork: under test it delivers **inline**, straight to `sentEmails`. The queue is real in dev and prod; in test it's transparent. The test never knew the queue arrived.

### Two ways to run the worker

In production the worker is its **own process** — a separate container from the API. That's the entire point of the deploy constraint I set for this project: a persistent worker, not serverless, so a slow mail provider ties up a *worker*, never an API request handler.

```plaintext
bun run src/worker.ts        # prod: the standalone consumer
```

But forcing two terminals in dev would silently break the signup→Mailpit flow the moment you forget the second one. So in development the API boots the same worker **in-process**:

```ts
// server.ts, after listen()
if (env.NODE_ENV === 'development') {
  createEmailWorker()   // one `bun run api` still delivers email end to end
}
```

Same worker module either way. Dev co-locates for convenience; prod splits for isolation. The split is config-shaped, not a code fork.

### Pass connection config, not a client

BullMQ's `connection` accepts either a live ioredis instance or a plain options object. Hand it an object:

```ts
new Queue(EMAIL_QUEUE_NAME, { connection: queueConnectionConfig() })  // { host, port, maxRetriesPerRequest: null, … }
```

…and BullMQ builds and **owns** its own connections from it. Two payoffs.

First, a blocking worker needs its *own* connection — a `BRPOPLPUSH` that waits indefinitely for the next job would stall anything sharing the socket — so letting BullMQ create them means you never accidentally share one.

Second, and subtler: BullMQ bundles its *own* copy of ioredis, often a different version than the app's. A `Redis` *instance* from one copy is a different class than the other's, so passing your app's client across that line is a type error (and an `instanceof` hazard at runtime). A plain options object has no class identity — it crosses cleanly.

The one option that matters is `maxRetriesPerRequest: null`, and it lives *only* on BullMQ's connections. The app's shared client keeps ioredis's default, so an ordinary cache GET fails fast instead of hanging forever waiting on a dead Redis.

BullMQ itself is the deliberate choice here, same reasoning as `argon2id` and `arctic`: a reliable queue (atomic claim, visibility timeout, backoff, dead-lettering) is genuinely hard to get right, so you stand on a vetted primitive rather than hand-roll the core.

### When this is the wrong shape

**The commit-and-enqueue gap.** Signup commits the user row, then enqueues. If the process dies in the microsecond between, the row exists and no email job does — the same lost-link symptom, just far rarer. Closing it needs a *transactional outbox*: write the job to Postgres in the same transaction as the user, and a relay moves it to Redis. That's the next tier of durability and deliberately not built here — the failure window went from "any SMTP hiccup" to "a crash in a one-instruction window," which is the right amount of hardening for this slice.

**The raw token rides in the job.** Only the token's *hash* is in the DB, but the queued job carries the raw token in its payload, briefly, in Redis. Acceptable — Redis is trusted infra and the job is dropped on delivery — but it's a wider blast radius than the DB, worth a note for a stricter threat model.

* * *

## Uniform signup: the same answer, whether you exist or not

Now I can pay off the debt I've flagged twice.

Login is enumeration-proof: one answer whether or not the email exists. Signup was not. It answered two different ways:

```plaintext
POST /auth/signup  { new@x.com }     → 201 Created   + a session cookie
POST /auth/signup  { taken@x.com }   → 409 Conflict  { "error": "email_taken" }
```

The `409` says, out loud: **someone already has this email here.**

That's the same leak we closed on *login* — just on the other door. An attacker with a list of ten thousand addresses POSTs each one and writes down the status code. Every `409` is a confirmed member.

On a public site, membership is no secret. On redline — a private tool for reviewing confidential documents — *who is on it* is the client list. The attacker reads it off the status codes, no password-guessing required.

### The fix: one answer for everyone

Both paths now return the identical response:

```plaintext
POST /auth/signup  { new@x.com }     → 200  "Check your email to finish signing up."
POST /auth/signup  { taken@x.com }   → 200  "Check your email to finish signing up."
                                        ↑ byte-for-byte the same
```

Same status, same body, no `error` field. The attacker's whole list comes back as `200`s. Nothing to write down.

The response can't carry the new-vs-taken signal now — so it goes where the inbox already is, a channel only the address owner can read:

```plaintext
new email    → the verification email          ("Confirm your email: <link>")
taken email  → one new message                  ("You already have an account — just log in.")
```

In code, the duplicate that used to throw now sends instead:

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

### The consequence: signup stops logging you in

This is the part that isn't obvious, and it's the actual cost.

The old new-email response set a **session cookie** — signup logged you straight in. A uniform response can't.

Because the taken path has no session to grant. That account isn't yours; you proved nothing by typing its address. So watch what happens if only the new path keeps its cookie:

```plaintext
new email    → 200 + Set-Cookie: session=...
taken email  → 200   (no cookie)
                ↑ the cookie is the tell again
```

The *presence of the cookie* becomes the difference the attacker was hunting. We'd have moved the leak from the status code into the `Set-Cookie` header and called it fixed.

So neither path sets one.

```plaintext
before:  sign up ──────────────────► you're in
after:   sign up → check email → log in → you're in
```

Signup says "check your email," cookie-free, every time. One extra step on the happy path, paid because *"sometimes a session, sometimes not"* is exactly the oracle we're closing.

### Then why does Google signup still log you in?

It does — and that looks like a contradiction. It isn't, because the two reasons password signup had to give up auto-login don't exist in the Google flow.

**No enumeration vector.** To even reach the "do you already have an account?" branch, you must *first* complete the OAuth handshake — prove to Google you control that account. An attacker can't probe `alice@gmail.com` without being alice at Google. The password leak was an *unauthenticated* request revealing membership; by the time Google's callback runs, the request is already authenticated. No anonymous oracle, so withholding the session would buy nothing.

**The email is already proven.** Password signup also couldn't log you in because the address was an unverified *claim*. Google sends `email_verified`, and a new user inherits it. Ownership is already proven, so there's no "check your email" to wait on.

So password signup withheld the session because the request was anonymous and the email unproven. Google signup is neither — so it logs you in, and that's correct, not an exception.

### The second tell: time

Identical bodies aren't enough; the clock can still leak — the same timing problem login had.

argon2id hashing is deliberately slow (~50ms) and is the dominant cost of a signup. If the taken path skipped it — hashing only when it's about to create the account — it would reply ~50ms sooner, and the attacker just stops reading the body and starts timing:

```plaintext
fast reply  → email is taken
slow reply  → email is new
```

So we hash on **both** paths, before the insert is even attempted. The taken path hashes a password it throws away — the same timing-equalizer move login makes with its decoy hash. A future reader who "optimizes" the hash to after the insert would silently reopen the oracle, which is why the code says so at that line.

### The whole flow

```plaintext
POST /auth/signup
↓
hashPassword(password)  ~50ms            (BOTH paths — timing equalizer)
↓
try: insert users + accounts in one tx
│
├── success ──► verification email ───────────┐
│                                             │
└── 23505  ──► sendAccountExistsEmail() ──────┤
                                              ↓
                200 "Check your email to finish signing up."
                (identical body, no cookie, either way)
```

Two paths in, one answer out. This is worth keeping only where *who is registered* is itself confidential — a private review tool, a medical portal, an internal admin. If membership isn't a secret — a forum, a game — a plain `409 "email taken"` is friendlier and costs new users no extra step. redline is the confidential kind, so it pays the step.

The endpoint tells everyone the same thing. The inbox tells the one person allowed to know. The clock tells no one anything.

* * *

## Manual account linking: when you've already proven both ends

Earlier, Mara's Google email matched her password email exactly, and the question was whether to auto-link. Now a different scenario.

Mara signed up with a password under `mara@work.test`. She wants to *also* sign in with Google — but her personal Google address is `mara@gmail.com`. A different email.

She has two ways to prove she's Mara. The system sees two strangers. Linking is making them one user: two `accounts` rows — one `password`, one `google` — pointing at one `users` row.

### Why the auto-link can't do this

The auto-link rule was: when a Google sign-in arrives, link it to an existing local account **only if the Google email is verified and matches**. Run Mara through it:

```plaintext
Google says: mara@gmail.com
Local has:   mara@work.test
```

The emails don't match. The auto-link looks for a local user with `mara@gmail.com`, finds none, and does the only safe thing it can for an anonymous caller: it creates a *brand-new, separate* account for `mara@gmail.com`. Now Mara has two accounts and no way to merge them.

That's not a bug. It's the auto-link being careful. Watch *why*.

### The asymmetry — this is the whole idea

The auto-link runs for an **anonymous** caller. Someone just showed up with a Google login. The server cannot tell Mara from an attacker who registered `mara@work.test` first. So it trusts almost nothing: it links only when both sides carry a verified, matching email — proof that can't be faked by typing an address.

Manual linking runs for a caller who has **already proven both ends**:

```plaintext
a valid session   → they own mara@work.test    (they're logged in)
a finished OAuth   → they control mara@gmail.com (Google just confirmed it)
```

Both halves are proven *before* the link function is even called. So it requires **no email match at all**. That's not a relaxed-security shortcut — it's the entire reason manual linking exists. The case the auto-link refuses (different email, or unverified) is exactly the case only a signed-in user should be allowed to resolve, by hand.

```plaintext
Anonymous caller → trust almost nothing → match verified emails.
Authenticated caller who finished OAuth → both ends already proven → no match needed.
```

### The flow, and the one new cookie

Mara is signed in. She clicks "Connect Google."

```plaintext
GET /auth/google/link        (server: she has a session? if not → 401)
↓
mint state + PKCE, set handshake cookies   ← same as sign-in
set the link marker cookie                 ← the one new thing
↓
redirect to Google's consent screen        (client → google.com)
↓
Google redirects back: GET /auth/google/callback?code=…&state=…
↓
verify state (CSRF), exchange code for claims   ← same as sign-in
↓
marker present? ── yes ──► re-check session ─► linkGoogleAccount(userId, claims) ─► redirect ?linked=google
              └─ no  ──► sign in (the normal path)
```

Google only lets us register **one** callback URL, so sign-in and link come back to the *same* `/auth/google/callback`. The callback has to know which one it is. That's what the marker cookie is for: the link route sets it; the callback reads it to pick the branch.

Notice the **re-check session** step. The marker only says "this was a link attempt." It does not say *who*. The session cookie says who — and it might have expired while Mara was on Google's consent screen. So the callback reads the session again, right then, and links to whoever is actually still signed in. The marker is a mode flag, never a trust token.

### The trap: a stale marker

Here's a bug that hides in the one path no test can reach (the callback needs a live Google to exercise).

`state` and `verifier` are written by *both* start routes, so they're always fresh. If the marker were written by *only* the link route, it could go stale:

```plaintext
Mara clicks "Connect Google"   → marker set (lives 10 min)
Mara abandons it at Google
Mara clicks "Sign in with Google" → sets new state + verifier…
                                     …but the old marker is still in the jar
↓
callback sees the marker → treats a plain sign-in as a link → mislink or a spurious 401
```

The fix is to make **both** start routes write a *definitive* mode. The link route sets the marker; the plain sign-in route **clears** it. Now there's exactly one source of truth per flow, and the callback can never read a marker left over from an abandoned flow.

```ts
// /auth/google (sign-in)         → clearOAuthLinkCookie(reply)
// /auth/google/link (linking)    → setOAuthLinkCookie(reply)
```

Because no test covers that branch, it has to be correct *by construction*. Two routes, two definitive writes, no leftover state.

### What linkGoogleAccount refuses

No email match — but not *no* rules. A Google identity belongs to exactly one user, and that's enforced:

```ts
// already linked to THIS user      → idempotent no-op (a double-click is success, not an error)
// already linked to ANOTHER user   → 409: you haven't proven you own that one
// this user already has a Google   → 409: one Google identity per account
// otherwise                        → insert; UNIQUE(provider, provider_uid) is the atomic backstop
```

The takeover-critical guarantee is that last index: even if two requests race past the in-code checks, the database lets exactly one `(google, sub)` row exist.

And the classic link-CSRF attack — an attacker gets an auth code for *their own* Google, then tricks a signed-in victim into hitting the callback with it, linking the attacker's Google into the victim's account — is already dead, from the same `state` check that stops sign-in CSRF. The attacker's code carries the attacker's state; the victim's browser never held it. The link never happens.

### When this is the wrong shape

Only **one direction** is built: this links Google *to* a signed-in account. The reverse — setting a password on a Google-only account — is a separate small flow, not built yet. Errors are **JSON mid-redirect**: a link conflict returns a `409` body in the browser, not a friendly page — frontend work, same as the sign-in errors. And **unlinking** — removing a provider, and refusing to remove the *last* one, which would lock the user out — is its own feature with its own guard. Not here.

The auto-link trusts the math, because the caller is a stranger. The manual link trusts the session, because the caller already signed in. Both end at the same place: two proofs, one person.

* * *

## Rate limiting: a leak somewhere else is a password list for here

Attackers rarely guess one password ten thousand times.

They take ten thousand email/password pairs leaked from *some other* site and try each one once against your login. People reuse passwords, so a small fraction work. This is **credential stuffing**, and a login endpoint that answers as fast as you can ask is its ideal target.

The defense isn't a better password check. It's a budget: a client gets N tries per minute, then the door stops opening.

### What we count, and where

One counter, per client IP (Internet Protocol address), per endpoint, per time window.

```plaintext
key:    rate-limit for POST /auth/login from 203.0.113.7
value:  a number, starting at 0
expiry: 1 minute
```

Every request does two things in Redis: `INCR` the counter, and set `EXPIRE` to the window on the first hit. When the counter passes the limit, the next request gets a `429 Too Many Requests` before it ever reaches the handler. A minute later the key expires and the budget resets.

The limits, tuned to how often a real person does each thing:

```plaintext
signup            5  / minute
login            10  / minute
verify           10  / minute
forgot-password   5  / minute
google (+ cb)    10  / minute
```

### Why the counter lives in Redis, not memory

The app will be deployed with two app instances behind a load balancer.

If each instance kept its counts in its own memory, an attacker capped at 10/min on instance A would get a *fresh* 10/min the moment the balancer sent them to instance B — 20/min across two, 30 across three. The limit would dissolve the more you scaled.

So the counter lives in **one shared Redis**. Both instances `INCR` the same key, so the attacker's 11th request is the 11th no matter which instance handles it. It's the same shared-Redis property that makes sessions work across instances: one source of truth, many readers.

The limiter only touches routes that opt in. `/health` and `/ready` are left out deliberately — the load balancer hits them every few seconds to decide whether to route traffic; throttling them would make the platform think the app is down and pull it from rotation. The limiter guards the doors attackers push on, not the ones the infrastructure knocks on.

### The whole thing rests on one value: `req.ip`

The counter keys on `req.ip`. Every request that shares a `req.ip` shares a bucket. So per-IP limiting is only as correct as `req.ip` being *the real client*. Get that wrong and the limiter doesn't bend — it breaks, in one of two opposite directions.

Here's the break. In production the request never reaches you directly:

```plaintext
client ──TCP──> load balancer ──new TCP──> your instance
```

The balancer doesn't pass the client's connection through. It opens its *own* TCP (Transmission Control Protocol) connection to your instance. So the socket your process sees belongs to the *balancer*, not the client.

If `req.ip` were the raw socket address, then in prod every request — from every user on earth — would arrive wearing the same IP. Now `signup` at 5/min is no longer 5 per user — it's 5 *total*, shared by the whole internet. The sixth signup anywhere trips it. The limiter has become a self-inflicted outage.

So how does the real client IP survive the hop? The balancer writes it into a header:

```plaintext
X-Forwarded-For: <original client>, <next hop>, ...
```

And `trustProxy` is the switch that decides which value Fastify reads into `req.ip`:

*   `trustProxy: false` → `req.ip` is the raw socket address. Whoever physically connected.
    
*   `trustProxy: <n>` → `req.ip` is taken from `X-Forwarded-For` instead — but only across the proxies you declare trustworthy.
    

It adds no security by itself. It only tells Fastify *which value to believe.* Locally, nothing sits in front of the app, so the socket address already *is* the real client — trust no proxy. That's why `TRUST_PROXY` is empty in local config. Empty isn't a missing value; it's the right value for an environment with no proxy.

### Why you count proxies instead of naming them

On a managed host (Railway, Render, Fly) there's no single balancer IP to point at. The balancer is a *fleet* — a pool of edge proxies that scale up and down and rotate addresses you're never handed. "Set `trustProxy` to the balancer's address" is a trap: pin one IP and it works until the platform adds a node next Tuesday.

The way out is to stop naming addresses and describe *trust* by position. Two pieces of "who sent this" arrive together, and they disagree:

The **socket address** — the IP at the far end of the real TCP connection. Nobody can forge it (you can't finish a handshake while pretending to hold an IP you don't), but behind a balancer it's *the balancer's* address: honest, identical on every request, useless for telling clients apart.

The `X-Forwarded-For` **header** — text that names the actual client. The right machine, but only as trustworthy as whoever wrote it.

`trustProxy`'s real job is to turn the header (right machine, maybe lying) into `req.ip` safely, using the socket address (honest, but the balancer) as its anchor. The rule every proxy obeys makes that possible:

> Forwarding a request, a proxy appends the address it received the request *from* — the socket address it saw — onto the end of `X-Forwarded-For`.

Watch it fill in. One client, one balancer:

```plaintext
client 9.9.9.9  ──TCP──>  balancer  ──TCP──>  your app

at the balancer:  its socket peer is 9.9.9.9    →  appends   X-Forwarded-For: 9.9.9.9
at your app:      header reads   X-Forwarded-For: 9.9.9.9
```

The balancer could not put the client into the *source IP* of its own connection to you — that slot is forced to be the balancer's address. So it wrote the client where it could: an appended header entry.

Fastify reassembles the route nearest-first — socket address, then header entries read right-to-left, because the *rightmost* was appended by the proxy *closest* to you:

```plaintext
[ balancer,     9.9.9.9 ]
  index 0        index 1
  nearest you    the client
```

`trustProxy: <n>` says: "the `n` hops nearest me are my proxies; trust their appends. `req.ip` is the entry just past them." For this app there's exactly one proxy between the internet and the app — the load balancer — so `n = 1`. (The two app instances are *not* hops: the balancer routes each request to one of them, and that instance sees exactly one proxy in front of it. Two instances is horizontal scale, not a chain.) Add a CDN (Content Delivery Network) in front and it'd be 2. Every forwarding layer you stack is `+1`. Reason it from your architecture, then confirm it once by logging `req.socket.remoteAddress` and `req.headers['x-forwarded-for']` from a device whose public IP you know — your IP's index *is* `n`.

### Why the count can't be tricked

The attacker *is* the client and wants a fresh IP every request, so they put a lie in the header they send:

```plaintext
attacker, real IP 9.9.9.9, sends:   X-Forwarded-For: 1.2.3.4   (a lie)
```

But the balancer obeys the rule — it appends *what it saw*, the attacker's real socket peer `9.9.9.9`, to the right of the lie:

```plaintext
Fastify's list, nearest-first:
[ balancer,     9.9.9.9,   1.2.3.4 ]
  index 0        index 1     index 2
  yours          real IP     the lie
```

`trustProxy: 1` stops at index 1 = **9.9.9.9**, the attacker's real address. The forged `1.2.3.4` sits at index 2 — past the trust boundary, never read.

That's the crux. A proxy you trust always writes the truth to the *right* of whatever the client wrote. You count in from the right, so the walk crosses only truthful appends and halts before it reaches the client's free text. The attacker can scribble anything on the left; you never read the left.

Both failure modes are the same mistake at opposite extremes — *where you stop counting*. Stop at zero (`false`, behind a balancer) and every request collapses onto the balancer's single IP: the whole internet throttled together. Walk to the end (`true`) and you land on attacker-controlled text: no throttle at all, a limiter that's present, configured-looking, and doing nothing. The safe stop is the exact number of proxies you own. For this app, `1`.

### A gap still open in the wiring

Honesty: the portable form — counting — does **not** actually work in this code yet.

Fastify branches on the *type* of the value: a **number** is a hop count, a **string** is a list of subnets. But the `TRUST_PROXY` env var is typed as `z.string()` and passed through untouched, so:

*   `TRUST_PROXY=10.0.0.0/8` → string → read as a subnet → the range form works.
    
*   `TRUST_PROXY=1` → the string `"1"` → Fastify tries to read `"1"` as a *subnet*, not a hop count → the count silently breaks.
    

So today the range form works and the count form does not. Closing it is a one-line coercion — if `TRUST_PROXY` is all digits, pass `Number(...)` so it reaches the number branch — left as a follow-up.

### The gotcha: a custom error handler eats the 429

The rate-limit plugin doesn't `reply.send` the 429 — it **throws** it. A thrown value lands in the app's error handler, and ours only recognizes the app's own `AppError` type; everything else it treats as an unexpected bug and turns into a `500`. So the first version, which returned a plain object, made every rate-limited request come back `500` instead of `429`. The limiter was working — the `x-ratelimit-remaining` header counted down to 0 — but the response was wrong.

The fix is to throw something the handler already understands:

```ts
errorResponseBuilder: (_req, context) =>
  new AppError('rate_limited', `Too many requests. Try again in ${seconds}s.`, 429)
```

The lesson generalizes: a custom error handler owns *every* error in the app, including the ones plugins throw.

### When this is the wrong shape

**Fail-open on a Redis outage.** If Redis is unreachable, the limiter lets the request through instead of blocking it. That's a deliberate trade: rate limiting is defense-in-depth, not the front door, so a Redis blip shouldn't lock every user out of login. The cost is no throttling at all during a Redis outage. Availability over security, chosen on purpose.

**Per-IP doesn't stop a botnet on one account.** This limits requests *per source IP*. An attacker spread across a thousand IPs, each making a few attempts at one victim's account, stays under every per-IP limit. Defending a single targeted account needs a *per-account* limit — attempts per email, regardless of source — a different counter for a different threat. Credential stuffing (many accounts, one source) is what per-IP stops; the per-account layer is future work.

Count the attempts, not the passwords. Share the count, so scaling out doesn't dissolve it. Fail open, so the guard never becomes the outage.

* * *

## Forgot password: a link that proves the inbox

A password reset looks like a new feature. It's really one we already built, pointed in a new direction.

Email verification proved a claim: *you control this inbox.* It did that with a single-use, hashed, expiring token mailed as a link. Forgot-password uses the **exact same mechanism** — and then spends that proof differently. Verification flips an `email_verified` flag. Reset lets you **replace the password.** Same proof of inbox control; a much bigger payoff. That's the whole idea, and also the whole danger: a reset link is a bearer credential that can take over an account, so every property below exists to keep it narrow.

### Two steps, two endpoints

```plaintext
/forgot-password (email)
   → POST /auth/forgot-password   → always 200; IF a password account exists, issue token + email link
   → link: ${APP_URL}/reset-password?token=…   (the FRONTEND, not the API — it has a form to show)
/reset-password (new password)
   → POST /auth/reset-password    → consume token, set hash, revoke ALL sessions
   → /login?reset=1
```

One asymmetry worth noticing: the verification link hits `GET /auth/verify` **on the API** directly, because it has nothing to collect — click and you're done. The reset link points at a **frontend page**, because the user still has to type the new password. The token rides the URL to the browser; the browser POSTs it back with the password.

### No enumeration — the same stance, a third time

`/forgot-password` returns a byte-identical `200 { message: "If that email has an account, we sent a password reset link." }` whether or not that email exists. Same stance as login and signup: the endpoint must not become an oracle that confirms which emails are registered. The service only *acts* — issues a token, sends mail — when a password account exists; otherwise it silently does nothing. The signal lands in an inbox only the owner reads.

The honest caveat: the real path does an extra token-insert + enqueue (~a few ms) that the unknown path skips, so there's a residual *timing* difference. It's far weaker than login's ~50ms argon2 gap (which we equalize with a decoy hash), and faking a row-insert to hide it isn't worth it at this tier — so it's accepted and documented, not hidden.

### The token: same shape, tighter dials

Reuses the same `generateToken` (256 bits) + `hashToken` (sha256) — only the **hash** is stored, so a DB leak yields no usable link. Single-use: consumed on success, and a used token reads identically to one that never existed. Two dials turned tighter than verification, because a reset is higher-risk:

*   **1 hour TTL**, not 24. A reset link is more dangerous to leave lying around.
    
*   **Issuing a new link invalidates the old one** — creating a reset token deletes any prior token for that user first, so only the most recent link works. Request three, only the third resolves.
    

### The reset is one transaction — all of it, or none

Verification flipped one flag and deleted one token in a transaction. Reset has *more* moving parts, and they must move together:

```ts
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ passwordHash }).where(/* this user's password account */)
  await tx.update(users).set({ emailVerified: true }).where(/* this user */)
  await tx.delete(passwordResetTokens).where(/* this token */)
  await tx.delete(sessions).where(/* every session for this user */)
})
```

Why atomic: a crash between "set new hash" and "consume token" would leave a **reusable link** for an already-changed password; a crash the other way would **spend the token without changing the password** — locking the user out with no working link. One transaction makes it all-or-nothing. (The argon2 hash is computed *before* the transaction, so the slow part doesn't hold row locks; the token is still unconsumed at that point, so a crash there just leaves a valid unused link — the safe failure.)

Two of those four statements deserve their own note:

*   `emailVerified: true` — clicking the reset link *is* proof of inbox control, the same proof verification asks for. So a reset doubles as a verification; no reason to leave the email unverified afterward.
    
*   **delete every session** — a reset is the "I think I'm compromised" button. Revoking all sessions logs out anyone holding a stolen cookie. The caveat is the one from the session cache: it has a 60-second read-through TTL, so a cached session can outlive the reset by up to a minute — we delete the Postgres rows instantly but don't hunt down per-user cache keys. Accepted, and called out rather than discovered later.
    

### One more email: the alarm

After a successful reset we queue a *"your password was changed"* notice to the owner, riding the same email queue. If an attacker who breached the inbox resets the password, this is the message that tells the real owner something happened. It's cheap, and it's the difference between a silent takeover and a noticed one.

### Scope, and when this is the wrong shape

Forgot-password is **password accounts only.** A Google-only account has no password to reset, so the flow deliberately does nothing for it (and, thanks to the uniform response, doesn't reveal that). Letting this flow *set* a first password on a Google account is a real feature — the "set-password / reverse link" door — but it's a different threat model, kept separate on purpose.

Two limits carry over from earlier. The **commit-and-enqueue gap** is here too: the token row is written, then the email enqueued best-effort, so a dropped enqueue means "check your email" with no mail — tolerable precisely because retrying is free. And rate limiting is **per-IP, not per-account**: a distributed attacker could trigger many reset emails to one victim from many IPs. The token is harmless without the inbox, so this is annoyance, not compromise; a per-account send throttle is the next dial if it matters.

Verification asked the inbox to prove a claim. Reset asks the same proof — and then lets it rewrite the password, once, atomically, and tells you it happened.

* * *

## What the whole thing taught me

Trace Mara end to end and the same handful of ideas keep doing the work.

**A claim is not a proof.** A typed-in email is a claim; a clicked link is a proof. Almost every dangerous decision in auth comes down to refusing to treat one as the other — the Google takeover, email verification, password reset all turn on it.

**The interesting question is never "can it be stolen."** Cookies, JWTs, reset links — assume they all leak. The design question is what the thief can do next, and whether you can turn the stolen thing off. That single question is why redline runs server sessions instead of JWTs.

**The best defenses are holes you never built.** Session fixation can't happen because there's no pre-login id to reuse. The forged-callback attack can't happen because `state` ties start to finish. You don't add those defenses; you build a shape that has no room for the attack.

**One secret, stored as its fingerprint, every time.** Passwords, session tokens, verification tokens, reset tokens — the raw secret lives in exactly one place the user holds, and the database keeps only a hash. A full database leak hands an attacker a column of fingerprints that open nothing.

**Say the same thing to everyone; tell the truth only to the inbox.** Login, signup, and forgot-password all give one answer regardless of whether you exist. The real signal moves to the one channel only the owner can read.

And the whole machine, in three beats:

```plaintext
The password proves who you are, once, and is never stored.
The session proves you're still you on every request, and is stored only as a hash.
Every link we mail proves you own the inbox — and that one proof is what verifies an address, links a second login, and resets a forgotten password.
```