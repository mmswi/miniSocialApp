# The pending-login token (the gap between "password OK" and "you're in")

> Increment: `feature/auth` — 2FA, the half-authenticated state.
> Files: `src/auth/mfa.ts`, `src/auth/cookies.ts`.

Mara has a passkey now. So her login has two steps, not one.

Step one: email and password. Correct.

Step two: her phone signs a challenge.

Between those two steps, something has to remember her.

That something is this whole doc.

---

## The gap nobody talks about

Without 2FA, login is one moment:

    password correct → mint a session → set the cookie → done

With 2FA, there's a gap in the middle:

    password correct → ??? → second factor → mint a session → done

What lives in the `???`.

She's proven one factor. She has not proven the second. She is **half-authenticated** — more than a stranger, less than logged in.

You cannot give her a session yet. A session is "fully logged in," and she isn't.

But you have to remember *something* across her next few requests, or step two has no idea who's knocking.

So: what do you store, where, and how do you keep it honest?

---

## The naive version, and why it quietly defeats 2FA

Here is the tempting shortcut.

The `/login` handler knows Mara's userId (it just checked her password). So hand that userId to the browser, and let the second-factor requests send it back:

```
POST /login            → { mfaRequired: true, userId: "mara-uuid" }   ← BAD
POST /2fa/verify        { userId: "mara-uuid", assertion: ... }        ← BAD
```

Read that second line again.

The userId is coming *from the client*.

Now picture an attacker. They have their own account and their own passkey. They know Mara's userId (it leaked, or it's in a URL somewhere). They call `/2fa/verify` with **Mara's userId** and **their own** assertion — signed by **their own** phone, which they can Face-ID all day.

If the server trusts that userId and just checks "is this a valid assertion for *some* credential," the attacker walks into Mara's account.

The password — the first factor — became decorative. The second factor authenticated the *attacker's* finger against the *attacker's* key, but logged them into *Mara's* account.

The bug is one word: the userId came from the request.

---

## The fix: the second factor's identity comes only from server state

The rule that makes 2FA real:

    After the password passes, the userId for the second factor
    comes ONLY from server-side state — never from the request.

So at `/login`, when the password is right and Mara has a passkey, we don't hand her a userId. We mint a **pending-MFA token**, and we keep the userId on *our* side, in Redis, under the token's hash:

```ts
// src/auth/mfa.ts
export const createPendingMfa = async (input: { userId: string }) => {
  const rawToken = generateToken()                         // 256-bit random
  const value = { userId: input.userId, challenge: null }
  await redis.set(pendingKey(rawToken), JSON.stringify(value), 'EX', PENDING_MFA_TTL_SECONDS)
  return { rawToken, expiresAt: new Date(Date.now() + PENDING_MFA_TTL_MS) }
}
```

The raw token goes to Mara in a cookie. The userId stays in Redis.

When step two arrives, the server reads the userId back *from Redis*, keyed by the token in her cookie:

```ts
export const loadPendingMfa = async (rawToken: string) => {
  const cached = await redis.get(pendingKey(rawToken))
  if (cached === null) return null
  return JSON.parse(cached) as { userId: string; challenge: string | null }
}
```

The attacker can send any userId they like in the body. Nobody reads it. The only userId that matters is the one *we* wrote, that *only Mara's cookie* can point at.

The first factor is load-bearing again.

---

## Why it's a different cookie from the session

Mara's pending token rides a cookie called `redline_mfa`. Not the session cookie. On purpose.

This is the trap to avoid:

    If the half-auth token were accepted by getSessionUser,
    then "password correct, second factor still pending"
    would already be "logged in."

That would skip the second factor entirely.

So the pending token lives in its own cookie, resolved only by `loadPendingMfa`, and the session resolver never looks at it:

```ts
// src/auth/cookies.ts
export const MFA_COOKIE_NAME = 'redline_mfa'   // separate from SESSION_COOKIE_NAME
```

Two cookies. One means "logged in." The other means "halfway there." They never cross.

---

## Same hash-at-rest trick as sessions

The pending token is a key — whoever holds it can finish Mara's login. So we treat it exactly like the session token.

The cookie holds the raw token. Redis stores only its `sha256` hash as the key:

```ts
const pendingKey = (rawToken: string) => `mfa:pending:${hashToken(rawToken)}`
```

A Redis leak hands the attacker a list of hashes. To use one, they'd need the raw token — which only ever lived in Mara's cookie. The hashes key nothing without it.

(Why sha256 and not argon2? Same reason as session tokens: the raw token is 256 bits of randomness, not a guessable password. Nothing to brute-force, so the fast hash is correct. The parent `01-auth-foundation.md` walks through this.)

---

## Single-use, and a bounded window

Two more properties keep the gap small.

**Single-use.** The pending entry is deleted the instant the second factor succeeds:

```ts
export const consumePendingMfa = (rawToken: string) => redis.del(pendingKey(rawToken))
```

A finished login can't be replayed. We consume *only* on success — a failed Face ID leaves the token alive so Mara can retry, but a completed one is gone.

**Bounded.** The entry carries a TTL. The half-authenticated state cannot linger:

```ts
const PENDING_MFA_TTL_MS = 1000 * 60 * 10   // 10 minutes
```

Ten minutes is plenty to glance at a Face ID prompt and tap. After that, the entry evaporates and Mara starts login over. The window where "password done, second factor pending" exists is small and self-closing.

The challenge gets written into the same entry later, when `/2fa/authenticate/options` issues it — and even that re-reads the userId from Redis rather than trusting the caller, so the invariant holds at every step:

```ts
export const attachPendingMfaChallenge = async (rawToken: string, challenge: string) => {
  const existing = await loadPendingMfa(rawToken)   // userId from Redis, again
  if (existing === null) return
  await redis.set(pendingKey(rawToken), JSON.stringify({ userId: existing.userId, challenge }), 'EX', PENDING_MFA_TTL_SECONDS)
}
```

---

## The five questions

    Where does it run?
    The server. The token is minted, stored, read, and burned server-side; Redis holds the state.

    What shape is the data?
    A 256-bit random token in the cookie; a small JSON value { userId, challenge } in Redis,
    keyed by the token's sha256 hash.

    What gets stored?
    In Redis: the userId (and later the challenge), under the hashed token, with a 10-minute TTL.
    In the browser: the raw token, in the httpOnly redline_mfa cookie. Never a session yet.

    What's computed fresh?
    A new random token per pending login; a hash-and-lookup on each 2FA request.

    What's handed on?
    A trusted userId — read only from server state — to the verify step, which finally mints a session.

---

## When this shape is overkill

If you only ever did passwordless passkey login — the passkey *is* the whole login, no first factor — you wouldn't need any of this. There's no "half" state to hold; the assertion either logs you in or it doesn't.

This pending-token dance exists precisely because we chose 2FA: two factors, two steps, and a gap between them that must not become a side door. A single-factor design has no gap to guard.

---

## The whole thing, in three beats

    The password proves factor one, but earns no session — only a pending token.
    The userId hides in Redis under the token's hash, so the second factor can't be aimed at someone else.
    Finish the second factor and the pending token is burned for a real session; stall, and it expires.
