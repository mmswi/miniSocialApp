# How the auth foundation works (and why it's built this way)

> Increment: `feature/auth` — password hashing, tokens, and server sessions.
> Files: `src/auth/password.ts`, `src/auth/tokens.ts`, `src/auth/session.ts`, `src/db/schema.ts`.

redline's auth has one job:

    How does the server know who you are on the next request,
    without trusting anything the browser could have faked or stolen?

Let me trace one person through the whole machine.

Her name is Mara. She signs up with an email and a password. Then she logs in. Then, weeks later, she logs out.

Follow Mara and the rest falls into place.

---

## First: never store the password

Mara types `hunter2-but-longer`.

The naive version stores exactly that:

```
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
  hash(plainPassword, ARGON2_OPTIONS);
```

### Why argon2id, and not just any hash

Not every hash is safe for passwords.

`sha256(password)` is a hash. It is also a terrible password hash.

Because it is *fast*. A modern GPU computes billions of sha256 per second. An attacker with your leaked table just tries billions of guesses until one matches.

A password hash should be *slow*. On purpose. Slow enough that a billion guesses becomes impractical.

`argon2id` is slow on purpose. It is also *memory-hard* — each guess must allocate real memory, which GPUs hate:

```ts
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB per hash
  timeCost: 2,
  parallelism: 1,
} as const;
```

19 MiB per attempt. That is nothing for one honest login. It is a wall for an attacker doing billions.

### Why a fresh salt matters

Run the same password through the same hash twice and you would normally get the same output.

That is a problem.

If two users both pick `password123`, identical hashes give it away. And an attacker can precompute a giant table of `hash → password` once and reuse it against everyone (a "rainbow table").

A salt kills both.

A salt is a random value mixed into each hash, so the same password hashes differently every time.

argon2 generates a fresh random salt per call and stores it *inside* the hash string. You do not manage it. You can see it work:

```ts
// from password.test.ts
const first = await hashPassword('same input');
const second = await hashPassword('same input');
expect(first).not.toBe(second); // same password, different hash
```

Same input. Different output. Every time.

To check Mara's password at login, argon2 reads the salt and parameters back out of the stored hash and recomputes:

```ts
export const isPasswordCorrect = (storedHash: string, plainPassword: string): Promise<boolean> =>
  verify(storedHash, plainPassword);
```

The comparison is constant-time, so an attacker cannot learn the password by measuring how long the check takes.

So, the five questions for this step:

    Where does it run?        The server. Always. The password never travels further than the login handler.
    What shape is the data?   A string in, a longer string out (the hash, salt and params baked in).
    What gets stored?         The hash. Never the password.
    What's computed fresh?    A new salt on every signup; a verify on every login.
    What's handed on?         A verified identity — "this really is Mara" — to the session step.

---

## Second: the cookie is a key, so store the lock, not the key

Mara is who she says she is. Now the server needs to remember that on her *next* request.

It hands her a token. A long random string. She stores it in a cookie and sends it back every time.

```ts
// src/auth/tokens.ts
export const generateToken = (): string => randomBytes(32).toString('base64url');
```

32 random bytes. 256 bits of entropy. Nobody guesses that.

Here is the tempting, naive version:

```
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
  createHash('sha256').update(rawToken).digest('hex');
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

### Why sha256 here, but argon2id for passwords

This looks like a contradiction. We just said sha256 is a bad password hash. Now we use it for tokens. On purpose.

The difference is what is being hashed.

A password is low-entropy. Humans pick `summer2024`. It is *guessable*, so the hash must be slow to make guessing expensive.

A token is 256 bits of pure randomness. It is *not guessable* — there is nothing to brute-force. So a fast hash is fine, and fast is good, because we verify tokens far more often than passwords.

Slow hash for the guessable thing.

Fast hash for the unguessable thing.

The same logic covers email-verification tokens — same `generateToken` / `hashToken`, stored hashed in `email_verification_tokens`, with the raw token only in the link we email.

---

## Third: why a server session, and not a JWT

Mara has a cookie. The server checks it on every request. But what is actually *in* that cookie? There are two designs, and they differ in one thing: where the identity facts live, and how the server trusts the cookie each time.

Think of it as a coat-check ticket versus a signed ID card.

### Our design — a coat-check ticket

Mara's cookie holds a random, meaningless string:

    k9f2x7q...   (43 random chars — says nothing on its own)

It is a ticket number. To learn who it belongs to, the server takes it to the back room and looks up what it points to:

    cookie = k9f2x7q...
    ↓  hash it: sha256(k9f2x7q...)
    ↓  look that hash up in the sessions table
    Postgres:  sha256(k9f2...) → { userId: mara, expiresAt: ... }

The facts live in the database. The cookie is just a pointer to them.

### The alternative — a JWT, a signed ID card

A JWT cookie holds the facts *themselves*, encoded, with a signature:

    eyJhbGci...  .  eyJ1c2VySWQiOiJtYXJhIn0  .  3aF9c...sig
       header              payload                signature

Base64-decode that middle part and it literally reads:

    { "userId": "mara", "exp": 1699999999 }

Anyone can read it. A JWT is not encrypted — only *signed*. The server wrote `userId: mara` and stamped it with a signature that only its secret can produce. So on each request the server does no lookup. It recomputes the signature over `header.payload` with its secret and checks it matches:

    cookie = eyJ...payload...sig
    ↓  HMAC(secret, header.payload) == sig ?
    ↓  yes → trust the payload. userId is mara.
    (no database — the proof rides inside the card.)

The facts live inside the token. The server stores nothing per session, only its one secret.

### This is not the same as our hashing

Easy to conflate, so to be explicit: hashing our token (`sha256` at rest) has nothing to do with JWT. We hash because we *store* the token, and a stored copy should be useless if the database leaks. A JWT is never stored — there is nothing to hash. Different concern.

    Ours:  random token  → STORE its hash, then look it up    (stateful)
    JWT:   signed facts   → STORE nothing, just verify math     (stateless)

### But can't someone just steal the cookie?

Yes. And here is the honest part: a stolen cookie and a stolen JWT are *exactly* as bad as each other.

Both are *bearer tokens*. Whoever holds it, is Mara. Steal her session cookie, or steal her JWT, and the thief is Mara until something stops them.

Our design is not more theft-resistant. A stolen cookie is a stolen cookie.

A stolen token does not hand over the database, by the way — it lets the holder act *as Mara* through the API, exactly as if they had logged in as her. Same as a stolen JWT.

    Can it be stolen?             ours: yes        JWT: yes      (identical)
    Can you kill it once stolen?  ours: instantly  JWT: not until it expires

So the interesting question is not whether the token can be stolen — both can. It is whether, once it is stolen, you can turn it off.

Now — why take the database hit on every request?

One word: revocation.

You might assume a JWT can be logged out. It mostly cannot.

A signed JWT is valid until it expires, because *nothing is checking a list*. The proof is self-contained. To kill it early you have to bolt a denylist back on — which quietly re-adds the database lookup you went stateless to avoid.

A server session is the opposite. Logout is a `DELETE`:

```ts
// src/auth/session.ts
export const revokeSession = (rawToken: string): Promise<void> =>
  revokeBySessionId(hashToken(rawToken));
```

The row is gone. The next request with that cookie finds nothing. Mara is out. Instantly. Everywhere that token was used.

For a document-review tool where people share access and need to *really* be removed, instant revocation is worth one lookup.

The five questions:

    Where does it run?        Verifying runs on the server, against Postgres.
    What shape is the data?   A random string in the cookie; a row in the database.
    What gets stored?         A row per session: the token hash, the user, an expiry.
    What's computed fresh?    A hash-and-lookup on every authenticated request.
    What's handed on?         "This cookie is Mara, and the session is still alive" — or null.

---

## Fourth: Redis sits in front, but Postgres is the truth

One lookup per request sounds cheap. At scale it is not — it is a database round-trip on *every* call, including every WebSocket message later.

So we cache it.

But caching identity is dangerous if you do it naively.

The naive version: store sessions *only* in Redis.

Fast. Also fragile. Redis is memory; restart it and everyone is logged out. And it makes revocation murky — which copy is the truth?

We avoid that by being strict about one thing:

    Postgres is the source of truth.
    Redis is only a fast shortcut in front of it.

This is a read-through cache. The flow:

    request with cookie
    ↓
    check Redis for this session          (fast path, in-memory)
    ↓ miss
    read Postgres                          (source of truth)
    ↓ found + not expired
    copy it into Redis with a short TTL    (so the next read is fast)
    ↓
    return the user

```ts
// src/auth/session.ts — the miss path repopulates the cache
const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
// ...
await redis.set(key, JSON.stringify(cacheValue), 'EX', ttl);
```

If Redis dies, nothing breaks. Every request just becomes a Postgres read again. Slower. Not broken.

### The one honest tradeoff: revoke-all vs the cache

Single logout is instant. We hold the raw token, so we delete the row *and* delete that exact Redis key:

```ts
const revokeBySessionId = async (sessionId: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await redis.del(cacheKey(sessionId));
};
```

"Log out everywhere" is different. We delete all of Mara's rows in Postgres immediately. But we do not hold every raw token, so we cannot bust every Redis key by hand.

A session cached a second before the revoke could still validate — until its cache entry expires.

So we keep that window short on purpose:

```ts
const CACHE_TTL_SECONDS = 60; // bounds how long a cached session can outlive a revoke-all
```

Sixty seconds. That is the tradeoff, stated plainly: single logout is instant; logout-everywhere is instant in Postgres and lags at most a minute in cache. We chose that over tracking every session key per user. For this app, a one-minute tail on "log out all devices" is fine. If it were a bank, it would not be.

---

## Fifth: a free defense you get just from the shape

There is a subtle attack called session fixation.

The attacker plants a known session id on a victim *before* they log in, then rides that same id after the victim authenticates.

It only works if the session id stays the same across the login boundary.

Ours cannot.

We do not have a session *before* login to reuse. We *mint a brand-new one* at the moment login succeeds:

```ts
// createSession runs on successful login — fresh random token every time
const rawToken = generateToken();
```

A fresh token on every login means there is no pre-login id to fix. The defense falls out of the design. We did not add a feature for it; we just never created the hole.

The good ones are often like that. The vulnerability is the thing you *didn't* build.

---

## When this is the wrong choice

Server sessions are not always right.

If you are building a fleet of stateless services that must verify identity with zero shared database — many microservices, edge functions — a signed JWT earns its keep, and you accept weaker logout.

We are a single app with one Postgres and one Redis. Instant revocation matters more than shaving a lookup. So: server sessions.

Pick the one that fits. Do not cargo-cult either.

---

## The whole thing, in three beats

    The password proves who you are, once, and is never stored.
    The session token proves you are still you, every request, and is stored only as a hash.
    Postgres holds the truth; Redis just makes reading it fast; deleting the row logs you out.
