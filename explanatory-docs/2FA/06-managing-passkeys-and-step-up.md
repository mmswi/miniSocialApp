# Managing passkeys, and the step-up that guards the off switch

> Increment: `feature/auth` — 2FA, day-two management and the disable path.
> Files: `src/auth/twofa-routes.ts`, `src/auth/webauthn.ts`, `src/auth/webauthn-challenge.ts`.

Mara turned on 2FA. Now she lives with it.

She buys a laptop and enrolls a second passkey. She names her phone "iPhone." Months later she sells the old laptop and removes its key. One day she wants 2FA off entirely.

Every one of those is a management action. Most are ordinary. One is dangerous.

This doc is about telling them apart.

---

## The ordinary actions

Listing, renaming, removing-one. Mara is signed in; her session proves who she is; the server just edits her own rows.

```
  GET    /auth/2fa/credentials       → her passkeys + how many recovery codes are left
  PATCH  /auth/2fa/credentials/:id   → rename one
  DELETE /auth/2fa/credentials/:id   → remove one (but see below)
```

Two small things make these safe.

**The list never leaks key material.** The Security page sees a projection, not the row:

```ts
const publicPasskey = (credential: WebauthnCredential) => ({
  id: credential.id,
  name: credential.name,
  backedUp: credential.backedUp,
  createdAt: credential.createdAt,
  lastUsedAt: credential.lastUsedAt,
})
```

No public key. No counter. No userId. The same discipline as `publicUser` for accounts — the client gets what it needs to draw a list and nothing it doesn't.

**Edits are scoped to the owner.** Rename and delete both filter by userId, so a credential id alone can't touch someone else's key:

```ts
.where(and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, userId)))
```

If the row doesn't belong to Mara, nothing matches, and she gets a clean "no such passkey" — never a peek at whether that id exists for someone else.

---

## The one dangerous action: dropping to zero

Here's the asymmetry that matters.

Removing *a* passkey when Mara has two is fine. She still has one. 2FA is still on.

Removing her *last* passkey is different. That turns 2FA off. So does the explicit "disable 2FA."

Those two — remove-the-last, and disable — are the dangerous ones, because they take the account from protected to unprotected.

So `DELETE` simply refuses to be the off switch:

```ts
if ((await countPasskeys(active.userId)) <= 1) {
  throw conflict('last_passkey', 'This is your last passkey. Disable 2FA to remove it.')
}
```

You cannot quietly delete your way to zero. The last step has to go through `/disable`, where there's a stronger gate.

---

## Why a valid session is not enough

Picture the attack this gate exists for.

Someone steals Mara's live session — a cookie lifted off an unlocked laptop, a hijacked tab. They are, as far as the server can tell, signed in as Mara.

If "disable 2FA" only needed a session, they'd just turn it off. Then they'd change her password, and the second factor that was supposed to protect her is gone — removed by the very session 2FA was meant to backstop.

So disabling 2FA demands something the session-thief does not have: a **fresh factor**, proven *right now*.

```ts
const proven = await proveFreshFactor({ userId, sessionId, proof })
if (!proven) {
  throw forbidden('step_up_failed', 'Confirm a passkey or a recovery code to disable 2FA.')
}
await disableTwoFactor(active.userId)
```

This is called **step-up**: a valid session gets you to the door, but a sensitive action makes you prove a factor again before it opens.

---

## What counts as a fresh factor

Two things, because Mara might be in either situation:

```ts
const proveFreshFactor = async ({ userId, sessionId, proof }) => {
  if ('recoveryCode' in proof) {
    return consumeRecoveryCode(userId, proof.recoveryCode)   // she still has her codes
  }
  // ...or a passkey assertion, verified against a step-up challenge:
  const challenge = await takeStepUpChallenge(sessionId)
  if (challenge === null) return false
  const credential = await getPasskey(proof.assertion.id)
  if (credential === null || credential.userId !== userId) return false   // her own key only
  const verified = await verifyPasskeyAuthentication({ response: proof.assertion, expectedChallenge: challenge, credential: ... })
  // ...
}
```

A passkey assertion is the clean path: she taps Face ID, signs a fresh challenge, done — nothing spent. The challenge for it is issued by `/stepup/options` and keyed to *her session*, so a challenge minted for one session can't be redeemed by another.

A recovery code is the fallback: maybe she's disabling 2FA *because* she lost the device, so the passkey isn't available. The code proves possession of the backup instead.

The session-thief has neither. They hold a cookie, not the phone and not the printed codes. Step-up stops them cold.

Notice the assertion path reuses the *exact* ownership check from the login flow (doc 05): `credential.userId !== userId` → rejected. A fresh factor has to be *Mara's* fresh factor.

---

## Turning it off is all-or-nothing

When step-up passes, `disableTwoFactor` wipes 2FA in one transaction:

```ts
export const disableTwoFactor = async (userId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
  })
}
```

Both tables, one transaction. Either 2FA is fully on or fully off — never a half state where the keys are gone but stale recovery codes linger, or the reverse. And because "2FA is enabled" is *derived* from the credential count (doc 02), deleting the keys is all it takes to flip the login gate back to single-factor. There's no separate flag to forget.

---

## The five questions

    Where does it run?
    The server. List/rename/delete edit rows; step-up verifies a fresh factor; disable wipes in one txn.

    What shape is the data?
    A safe passkey projection out; a step-up challenge in Redis keyed by sessionId; an assertion or a
    recovery code in.

    What gets stored?
    Renamed/deleted credential rows. A step-up challenge (single-use, GETDEL). After disable: nothing —
    both 2FA tables are cleared for the user.

    What's computed fresh?
    A passkey count on every delete (to protect the last one); a fresh-factor proof on every disable.

    What's handed on?
    Management → an updated list. Disable → a single-factor account, the login gate flipped back off.

---

## Where step-up is the wrong amount of friction

Step-up is a deliberate speed bump. Put it on the wrong action and you just annoy people.

Renaming a passkey doesn't get step-up — relabeling "iPhone" to "Work phone" changes no security posture, so demanding Face ID for it would be theater. Removing a non-last passkey doesn't either: 2FA stays on, the blast radius is small.

We spend the friction only where the account goes from protected to unprotected — disable, and remove-the-last. That's the whole art of step-up: not "re-auth for everything," but "re-auth for the actions a stolen session would abuse." Guard the off switch, leave the light switches alone.

---

## The whole thing, in three beats

    Ordinary edits — list, rename, remove-one — ride the session and touch only the owner's rows.
    Dropping to zero is special: DELETE refuses the last key, and disable demands a fresh factor.
    Step-up proves a passkey or a recovery code right now, so a stolen session can't strip 2FA off.
