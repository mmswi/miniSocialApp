# Recovery codes (what happens when the phone goes in the lake)

> Increment: `feature/auth` — 2FA, the lose-your-phone backup.
> File: `src/auth/recovery-codes.ts`.

Mara enrolled a passkey. Her account is safer.

It is also more fragile in exactly one way.

The passkey lives in one device's secure hardware.

Drop that phone in a lake, and the private key is at the bottom of the lake with it.

So this doc is about the escape hatch.

---

## Why "reset my passkey" cannot exist

With a password, losing it is fine. You click "forgot password," prove you own the email, set a new one. The server always *could* set a new password, because the server controls the password.

A passkey is the opposite.

The server never had the private key. It can't reset what it never held. There is no "email me a new passkey."

So the naive recoveries don't work:

    "Let support flip 2FA off."   → now a support social-engineer is your second factor.
    "Email a magic link to disable 2FA."  → now your email is your second factor, and email is phishable.

Each of those quietly hands the second factor back to something weaker. The whole point was to *not* depend on a phishable channel.

We need a backup that's as strong as the passkey, handed to Mara up front, while she still has the device.

That's a recovery code.

---

## Collapse the definition

A recovery code is a one-time password you were given in advance.

That is all it is.

We generate ten of them the moment Mara enrolls her first passkey. We show them once. She saves them somewhere safe — a password manager, a printout in a drawer.

Months later, phone in the lake, she types one in instead of using her passkey. It logs her in. Then it's dead — used up, never again.

Ten codes. Each works exactly once.

---

## What a code looks like, and why

```
A7KM-9QR3-FXP2
```

Three groups of four, from a deliberately small alphabet:

```ts
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0 O 1 I L
```

Look at what's missing: no `0` or `O`, no `1` or `I` or `L`.

Those are the characters people mistype when reading off paper. Leave them out and a misread can't accidentally land on a different valid code.

Each code is 12 characters from 32 symbols — about 60 bits of entropy. Unguessable. And they're single-use and rate-limited on top, so there's nothing to brute-force.

The dashes are just for the eye. When Mara types it back, we don't care about her dashes or her caps lock:

```ts
const normalizeRecoveryCode = (rawCode: string): string =>
  rawCode.toUpperCase().replace(/[\s-]/g, '')
```

`a7km9qr3fxp2`, `A7KM-9QR3-FXP2`, `A7KM 9QR3 FXP2` — all canonicalize to the same thing before we hash it. The stored hash and the typed-back code always meet in one shape.

---

## Stored like every other secret here: hashed, never in the clear

We never store the codes themselves.

If we did, a database leak would hand the attacker ten working 2FA-bypasses per user.

So we store only a hash — and we salt it with the userId:

```ts
const recoveryCodeId = (userId: string, normalizedCode: string): string =>
  hashToken(`${userId}:${normalizedCode}`)   // sha256(userId + ':' + code)
```

Why salt with the userId?

A bare `sha256(code)` would make the hash global — two users who happened to get the same code would collide on the primary key, and one enrollment would fail. Worse, identical codes would produce identical hashes, leaking that they match.

Salting with the userId scopes each hash to its owner. A code is only ever looked up in the context of a known user — and at login that user is the one from the pending-MFA token (the previous doc), never the request. Same invariant, carried through.

(Why sha256 and not argon2? Same reasoning as session and pending-MFA tokens: a code is 60 bits of randomness, not a guessable human password. Nothing to slow-hash. The parent `01-auth-foundation.md` covers the slow-vs-fast split.)

---

## Single-use, enforced by the database

"Each code works exactly once" sounds like a rule you check in code. It isn't. It's enforced in one query.

```ts
export const consumeRecoveryCode = async (userId: string, rawCode: string): Promise<boolean> => {
  const id = recoveryCodeId(userId, normalizeRecoveryCode(rawCode))
  const consumed = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.id, id), eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id })
  return consumed.length > 0
}
```

The `isNull(usedAt)` in the WHERE is the whole trick.

It says: mark this code used *only if it is currently unused*. The database does the check and the write in one atomic step.

So picture a double-submit — Mara fat-fingers the button twice, two requests race. Both compute the same code id. Both try to update the row `WHERE used_at IS NULL`. The database lets exactly one of them match: the first sets `used_at`, the second now finds nothing matching `IS NULL` and updates zero rows.

`.returning()` tells us which we were. One row back means we consumed it (`true`). Zero rows means it was unknown, or already spent (`false`). No read-then-write gap for a race to slip through.

---

## Shown once, then unrecoverable

`generateRecoveryCodes` is the only place the raw codes ever exist outside Mara's saved copy:

```ts
export const generateRecoveryCodes = async (userId: string): Promise<string[]> => {
  // ...generate ten distinct codes, store ONLY their salted hashes...
  return rawCodes // the caller shows these once, and we never have them again
}
```

It returns the raw codes for the route to display, and keeps only the hashes. There is no "show me my codes again" endpoint, because there is nothing to show — we threw the originals away on purpose.

Regenerating is the same call. It deletes the old batch inside a transaction and writes a fresh ten, so an old printout stops working the moment a new one is issued. And `countRemainingRecoveryCodes` powers the nudge — "you have 3 codes left" — so Mara regenerates before she runs out.

---

## The five questions

    Where does it run?
    The server. Generation, hashing, and the atomic consume all happen server-side, against Postgres.

    What shape is the data?
    A short human-typed string (e.g. A7KM-9QR3-FXP2); at rest, only its salted sha256 hash in a row.

    What gets stored?
    One row per code: sha256(userId + ':' + code), with a used_at that's null until spent.
    Never the code itself.

    What's computed fresh?
    Ten new codes at enrollment (or regeneration); a hash-and-atomic-update on each attempt.

    What's handed on?
    A yes/no — was this a real, unused code? — to the login step, which then mints the session.

---

## The honest tradeoff

A recovery code is a bearer secret. Whoever holds it can pass the second factor — that's the entire job. So a leaked code is as dangerous as a leaked password, minus the username.

That's the deal we accept for not locking Mara out forever. We blunt it the ways you'd expect: the codes are single-use, the endpoint is rate-limited, regenerating burns the old set, and we tell Mara plainly to store them like passwords.

When are recovery codes the wrong tool? If you can guarantee a second hardware key — issue every user two security keys, keep one in a safe — you sidestep the lose-your-only-device problem without a printable bypass at all. Most people don't have a spare YubiKey in a drawer. Mara doesn't. So she gets codes.

---

## The whole thing, in three beats

    The passkey can't be reset, because the server never held it — so we hand out a backup up front.
    Ten one-time codes, shown once, stored only as per-user salted hashes.
    The database marks each used atomically, so a code opens the door exactly once and never again.
