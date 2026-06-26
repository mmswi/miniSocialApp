# Wiring the two-factor login (where all the pieces finally meet)

> Increment: `feature/auth` — 2FA, the HTTP routes.
> Files: `src/auth/twofa-routes.ts`, `src/auth/routes.ts`, `src/auth/password-auth.ts`,
> `src/auth/webauthn-challenge.ts`, `src/auth/route-helpers.ts`.

We have all the parts now.

The service that verifies a passkey (doc 02). The pending-login token (doc 03). Recovery codes (doc 04).

This doc is the assembly. The actual endpoints Mara's browser calls.

Two journeys: turning 2FA on, and then logging in with it.

---

## Login now has two endings

Before 2FA, `loginWithPassword` had one outcome: a session.

Now it has two, and the type says so out loud:

```ts
// src/auth/password-auth.ts
export type PasswordLoginResult =
  | { status: 'authenticated'; user: User; session: CreatedSession }
  | { status: 'mfa_required'; userId: string }
```

A correct password is no longer the end of the story. If the user has a passkey, the function stops and returns `mfa_required` with *only* the userId — no session:

```ts
if (await hasEnrolledPasskey(account.userId)) {
  return { status: 'mfa_required', userId: account.userId }
}
```

One detail matters for security: this branch is reached *only after the password verified*. So `mfa_required` can never tell an attacker "this email has 2FA" — they'd already have needed the right password to see it.

The `/login` route reads the discriminated result and forks:

```ts
// src/auth/routes.ts
if (result.status === 'mfa_required') {
  const pending = await createPendingMfa({ userId: result.userId })
  setMfaCookie(reply, pending.rawToken, pending.expiresAt)
  return reply.send({ mfaRequired: true })   // ← no session cookie on this path
}
setSessionCookie(reply, result.session.rawToken, result.session.expiresAt)
return reply.send({ user: publicUser(result.user, linkedProviders) })
```

The fork is the whole point: one branch hands out a session, the other hands out a *pending* token and asks for more.

---

## Turning 2FA on: the enrollment round trip

Mara is already signed in. She clicks "add a passkey." Two requests.

```
  POST /auth/2fa/register/options   (her session cookie proves who she is)
    → build options { challenge, excludeCredentials, rp, ... }
    → store the challenge in Redis, keyed by her userId
    → return options
  browser: navigator.credentials.create(options)   ← Face ID; makes the key pair
  POST /auth/2fa/register/verify    { response, name? }
    → take the stored challenge back (GETDEL — single use)
    → verifyPasskeyRegistration(response, challenge)
    → store the public key
    → if this is her FIRST passkey: generate 10 recovery codes, return them ONCE
```

Notice where the challenge lives. At enrollment Mara has a session, so we key the challenge by her userId:

```ts
// src/auth/webauthn-challenge.ts
const registrationChallengeKey = (userId: string) => `webauthn:challenge:reg:${userId}`
export const takeRegistrationChallenge = (userId: string) =>
  redis.getdel(registrationChallengeKey(userId))   // read-and-delete, atomic, single-use
```

That's different from the *login* challenge, which has no session to key on and rides the pending-MFA entry instead (doc 03). Same idea — a server-issued challenge the verify step demands back — keyed differently because enrollment knows the user and login doesn't yet.

And the recovery codes are minted here, at the *first* passkey, not later:

```ts
const isFirstPasskey = !(await hasEnrolledPasskey(active.userId))
await storePasskey({ userId: active.userId, registration: verified, name: body.name ?? null })
const recoveryCodes = isFirstPasskey ? await generateRecoveryCodes(active.userId) : undefined
return { credentialId: verified.credentialId, recoveryCodes }
```

The moment 2FA turns on is the moment Mara could get locked out — so that's the moment she gets her backup. Check `isFirstPasskey` *before* storing, or the new row makes every enrollment look like the first.

---

## Logging in with 2FA: the second round trip

Now the everyday path. Mara enters email and password.

```
  POST /auth/login           → password OK, has passkey → { mfaRequired: true }
                                + redline_mfa cookie, NO session
  POST /auth/2fa/authenticate/options   (reads redline_mfa cookie)
    → load the pending login → her userId
    → build options { challenge, allowCredentials: her keys }
    → attach the challenge to the pending entry
    → return options
  browser: navigator.credentials.get(options)   ← Face ID; signs the challenge
  POST /auth/2fa/authenticate/verify    { response }
    → load pending → { userId, challenge }
    → the asserted credential must belong to THIS user        ← the guard
    → verifyPasskeyAuthentication(response, challenge, storedKey)
    → update the counter
    → finishMfaLogin: burn pending, clear cookie, MINT SESSION
```

Every one of those `/2fa/authenticate` handlers begins the same way — by resolving the cookie to a pending login, server-side:

```ts
const requirePendingMfa = async (rawToken: string | undefined) => {
  const pending = rawToken === undefined ? null : await loadPendingMfa(rawToken)
  if (rawToken === undefined || pending === null) {
    throw unauthorized('mfa_not_pending', 'Your sign-in expired. Start again.')
  }
  return { rawToken, userId: pending.userId, challenge: pending.challenge }
}
```

The `userId` comes out of Redis. Never out of the request body. That is the invariant from doc 03, now enforced at every route that finishes a login.

---

## The guard that makes the second factor real

Here is the line the whole feature hinges on:

```ts
const credential = await getPasskey(body.response.id)
if (credential === null || credential.userId !== pending.userId) {
  throw badRequest('webauthn_unknown_credential', 'That passkey is not registered here.')
}
```

Picture the attack. An attacker has *their own* account and *their own* passkey. They steal a glimpse of the victim's pending login — or just try. They send the victim's pending cookie, but sign the challenge with their *own* Face ID, their *own* key.

Without this check, the server might think "this is a valid assertion for a real, registered passkey" and let them in — as the victim.

The check stops it cold. The asserted credential's `userId` must equal the pending login's `userId`. The attacker's key belongs to the attacker, not the victim. Mismatch. Rejected before we even verify the signature.

A valid assertion for the wrong account is worth nothing.

---

## Session creation has exactly one home

In the whole 2FA flow, `createSession` runs in one place — the shared tail both success paths call:

```ts
const finishMfaLogin = async (reply, req, rawMfaToken, userId) => {
  await consumePendingMfa(rawMfaToken)   // burn the pending token (single-use)
  clearMfaCookie(reply)                  // drop the half-auth cookie
  const session = await createSession({ userId, ip: req.ip, userAgent: ... })
  setSessionCookie(reply, session.rawToken, session.expiresAt)
  // ...return the public user
}
```

Passkey login calls it after a verified assertion. Recovery-code login calls it after a consumed code. Nowhere else in the flow is a session minted. One door to "you're fully in," and both factors have to walk through it.

(Recovery-code login is the same shape, minus the signature: `consumeRecoveryCode` instead of `verifyPasskeyAuthentication`, then the very same `finishMfaLogin`.)

---

## The five questions

    Where does it run?
    The server, across five endpoints. The key work (create/get) happens on the device between them.

    What shape is the data?
    JSON option blobs and assertion responses on the wire; a pending entry and a challenge in Redis;
    a session cookie at the very end.

    What gets stored?
    The enrollment challenge (Redis, keyed by userId) and the login challenge (on the pending entry).
    A passkey row on enroll, recovery codes on the first enroll. A session only after both factors pass.

    What's computed fresh?
    A challenge per options call; an ownership check + signature verify per assertion; a session per
    completed login.

    What's handed on?
    register → a stored passkey (+ first-time recovery codes). authenticate/recovery → a real session.

---

## When this many endpoints is too many

Five routes for "log in" is a lot of surface. If the only goal were a quick demo, you could fake it with one fat endpoint that takes everything at once.

But WebAuthn is a challenge/response handshake: the server has to issue a challenge, the device has to sign it, and the server has to verify that exact challenge. That's inherently two round trips per phase — options, then verify — and you can't collapse them without throwing away the replay protection the challenge buys you.

So the endpoint count isn't accidental complexity we added. It's the protocol's shape, made honest. The split we *did* choose — a separate `twofa-routes.ts` plugin instead of piling onto `routes.ts` — is just housekeeping, so the core auth file stays about passwords and sessions, and the passkey handshake lives on its own.

---

## The whole thing, in three beats

    Login forks: a password alone earns a pending token, not a session.
    Enroll stores a public key and hands out recovery codes the first time; the challenge is single-use.
    The second factor must belong to the pending user, and only then does one shared step mint the session.
