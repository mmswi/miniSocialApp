# Two-factor auth with passkeys — the map

> Increment: `feature/auth` — the whole 2FA slice, in one place.
> Start here, then read 01 → 08 in order. Each builds on the last.

## What this is

A second factor for login, built on **WebAuthn passkeys** — the thing behind "scan your face to sign
in." After a 2FA user's password is correct, the account still isn't open: their device has to sign a
server challenge (unlocked by Face ID / Touch ID / a security key) before any session exists. If the
device is lost, ten one-time recovery codes are the way back in.

It's a **second factor, not passwordless.** The password (or Google) is still factor one; the passkey
is factor two. That single choice shapes every flag and flow in here.

## Read in this order

| # | Doc | What it covers |
|---|-----|----------------|
| 01 | what-a-passkey-actually-is | The mental model: public-key crypto, why your face never leaves the phone, RP ID vs origin, why a signature can't be replayed |
| 02 | how-we-store-and-verify-a-passkey | The data model + the service: option builders, verify wrappers, base64url storage, the library-owned counter |
| 03 | the-pending-login-token | The half-authenticated state, and the invariant: the second factor's userId comes only from server state |
| 04 | recovery-codes | The lose-your-phone backup: salted hashes, atomic single-use, why "reset my passkey" can't exist |
| 05 | wiring-the-two-factor-login | The routes: the login fork, enroll, the second-factor login, the ownership guard, the single session-creation site |
| 06 | managing-passkeys-and-step-up | List/rename/remove, and step-up: why a valid session isn't enough to turn 2FA off |
| 07 | the-browser-half-of-the-handshake | The login frontend: startAuthentication, the three-step dance, the recovery fallback |
| 08 | enrolling-and-the-show-once-problem | The Security page: making a key, the show-once recovery codes, disabling from the client |

## The one invariant everything hangs on

> After the password passes, the userId for the second factor comes **only** from server-side state,
> never from the request.

Get this wrong and the first factor is decorative — an attacker could point the second factor at a
victim's account. It's enforced at the pending-MFA token (03), at every login route (05), and again at
step-up (06). The ownership guard (`credential.userId === pending.userId`) is its teeth: a valid
assertion for the *wrong* account is worth nothing.

## What each piece defends against

| Threat | Defense | Doc |
|--------|---------|-----|
| Phishing (fake site relays your code) | Origin-bound passkeys — the browser won't sign for `evil.com` | 01 |
| Password leak / reuse | 2FA: the password alone earns no session | 03, 05 |
| DB leak exposing secrets | Only public keys + hashed tokens/codes at rest | 02, 03, 04 |
| Aiming the 2nd factor at someone else | userId from server state + the ownership guard | 03, 05, 06 |
| Replayed assertion / code | Single-use challenges (GETDEL), single-use pending token + recovery codes | 03, 04, 05 |
| Hijacked live session stripping 2FA | Step-up: a fresh factor to disable / remove the last passkey | 06 |
| Lost device → permanent lockout | Ten recovery codes, shown once at first enrollment | 04, 08 |

## What's deliberately NOT covered (decision D3)

**Google sign-in does not enforce 2FA.** A user with a passkey can still log in via "Continue with
Google" without the second factor. The Google callback is a redirect flow that mints a session
directly; gating it means redirecting to a frontend `/2fa` step with the pending cookie — real extra
work that was scoped out. This is a **known gap**, not an oversight. The threat model that matters
first is the password path. (Decisions: D1 passkeys over TOTP · D2 recovery codes in · D3 this gap ·
D4 full management + step-up.)

Also out of scope on purpose: passwordless passkey login (this is second-factor only), TOTP as an
alternate factor, and admin-mandated 2FA enforcement.

## An honest word on testing

You cannot drive a real authenticator (Face ID) from a test — the biometric and the secure chip
aren't scriptable. So **there is no real end-to-end passkey test, and nothing here claims to be one.**
What's tested:

- The state machine we own — pending-token issuance/expiry/single-use, the ownership guard, counter
  updates, recovery-code consumption, step-up gating — exercised for real, with the `@simplewebauthn`
  verify mocked at the boundary (backend) or `startRegistration`/`startAuthentication` mocked (frontend).
- The **recovery-code path is the no-mock end-to-end** for both login and disable — a full round trip
  through the route machine without a real authenticator.

Backend: 112 pass / 1 skip. Frontend: 17 pass. The passkey-assertion *success* path is covered at the
service layer and named honestly everywhere it appears.

## The whole thing, in three beats

    The password proves factor one; a device signature (or a recovery code) proves factor two.
    Nothing secret is stored — only public keys and hashes — and the second factor is always aimed by the server.
    Lose the device and codes get you back; a stolen session still can't turn the lock off.
