import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers'
import { and, count, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { type WebauthnCredential, recoveryCodes, webauthnCredentials } from '../db/schema.ts'
import { env } from '../lib/env.ts'

/*
 * WebAuthn passkey 2FA — the crypto-orchestration + credential store (2FA design M2)
 *
 * This module owns four things and nothing else: building the option blobs the browser feeds to
 * navigator.credentials.{create,get}, verifying the responses that come back, and reading/writing
 * the credential rows. The challenge lifecycle (Redis) and the login/route wiring live elsewhere
 * (mfa.ts, routes.ts) — kept apart so this stays a pure "given a challenge, prove the key" layer.
 *
 *   register:  buildPasskeyRegistrationOptions ──► browser ──► verifyPasskeyRegistration ──► storePasskey
 *   login:     buildPasskeyAuthenticationOptions ─► browser ─► verifyPasskeyAuthentication ─► touchPasskeyCounter
 *
 * The PUBLIC key is the only secret material we store, as base64url TEXT; it's decoded to bytes
 * only at the verify boundary. The private key never leaves the device's secure hardware.
 */

// The single origin the browser is actually at (Vite serves the app and proxies /auth to the API,
// so there's exactly one). `.origin` strips any stray path/trailing slash APP_URL might carry —
// WebAuthn compares the origin byte-for-byte, so a trailing slash would silently fail every verify.
const EXPECTED_ORIGIN = new URL(env.APP_URL).origin

// We're building a SECOND factor, not passwordless sign-in. That choice drives two flags everywhere:
//   residentKey 'discouraged' — don't ask the authenticator to store a discoverable credential
//                               (that's the passwordless feature; here the password is factor one).
//   userVerification 'preferred' — prompt for the biometric (the Face ID the user wanted) where the
//                               device supports it, but don't HARD-fail authenticators that can't do
//                               it — possession of the key is itself the second factor. Paired with
//                               requireUserVerification:false at verify time, or 'preferred' would
//                               behave like 'required' and lock out UV-less security keys.
const USER_VERIFICATION = 'preferred' as const

// The fresh-from-the-authenticator fields we keep after a registration verifies, before the row
// gets a name. transports is normalized to null (the column is nullable) rather than undefined.
type VerifiedPasskeyRegistration = {
  credentialId: string
  publicKey: string
  counter: number
  transports: AuthenticatorTransportFuture[] | null
  deviceType: string
  backedUp: boolean
}

// A credential's id + transports, the shape allow/excludeCredentials want. `?? undefined` because the
// library omits the field when there are no transports; our column stores null for the same absence.
const toCredentialDescriptor = (credential: {
  id: string
  transports: AuthenticatorTransportFuture[] | null
}): { id: string; transports?: AuthenticatorTransportFuture[] } => ({
  id: credential.id,
  transports: credential.transports ?? undefined,
})

// Step 1 of enrollment: the option blob for navigator.credentials.create(). It carries a fresh
// random challenge (the caller stashes options.challenge in Redis); excludeCredentials greys out
// devices the user already enrolled so they can't register the same authenticator twice.
export const buildPasskeyRegistrationOptions = (input: {
  userId: string
  userName: string
  existingCredentials: { id: string; transports: AuthenticatorTransportFuture[] | null }[]
}): Promise<PublicKeyCredentialCreationOptionsJSON> =>
  generateRegistrationOptions({
    rpID: env.RP_ID,
    rpName: env.RP_NAME,
    // A stable user handle = our user id, so re-enrollments map to the same WebAuthn user (the lib
    // would otherwise mint a random one each call). Non-discoverable creds barely use it, but stable
    // is correct.
    userID: isoUint8Array.fromUTF8String(input.userId),
    userName: input.userName,
    attestationType: 'none',
    excludeCredentials: input.existingCredentials.map(toCredentialDescriptor),
    authenticatorSelection: { residentKey: 'discouraged', userVerification: USER_VERIFICATION },
  })

// Step 2 of enrollment: verify the attestation against the challenge we issued. Returns the fields
// to persist, or null if the response didn't verify (the route turns null into a clean 400). The
// verify fn is injectable so tests can exercise this without a real authenticator.
export const verifyPasskeyRegistration = async (
  input: { response: RegistrationResponseJSON; expectedChallenge: string },
  verify: typeof verifyRegistrationResponse = verifyRegistrationResponse,
): Promise<VerifiedPasskeyRegistration | null> => {
  const result = await verify({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: EXPECTED_ORIGIN,
    expectedRPID: env.RP_ID,
    // See USER_VERIFICATION: 'preferred' UX means we accept a response even if the authenticator
    // couldn't do user verification. The biometric still fires on devices that support it.
    requireUserVerification: false,
  })
  if (!result.verified) {
    return null
  }
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo
  return {
    credentialId: credential.id,
    // bytes ➜ base64url text for the DB; reversed by isoBase64URL.toBuffer at auth-verify time.
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? null,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  }
}

// Step 1 of a 2FA login: the option blob for navigator.credentials.get(). allowCredentials is the
// user's enrolled creds (we know who they are — the password already passed), so the browser only
// offers a key that can actually satisfy this account. Carries a fresh challenge to stash in Redis.
export const buildPasskeyAuthenticationOptions = (input: {
  allowCredentials: { id: string; transports: AuthenticatorTransportFuture[] | null }[]
}): Promise<PublicKeyCredentialRequestOptionsJSON> =>
  generateAuthenticationOptions({
    rpID: env.RP_ID,
    allowCredentials: input.allowCredentials.map(toCredentialDescriptor),
    userVerification: USER_VERIFICATION,
  })

// Step 2 of a 2FA login: verify the assertion against the stored public key + the issued challenge.
// Returns the authenticator's new signature counter to persist, or null if it didn't verify. We do
// NOT compare the counter ourselves — the library handles clone detection, and synced passkeys
// report 0 forever, so a hand-rolled "must increase" rule would lock out every iPhone.
export const verifyPasskeyAuthentication = async (
  input: {
    response: AuthenticationResponseJSON
    expectedChallenge: string
    credential: VerifiedPasskeyRegistration | StoredPasskeyCredential
  },
  verify: typeof verifyAuthenticationResponse = verifyAuthenticationResponse,
): Promise<{ newCounter: number } | null> => {
  const result = await verify({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: EXPECTED_ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
    credential: {
      id: input.credential.credentialId,
      publicKey: isoBase64URL.toBuffer(input.credential.publicKey),
      counter: input.credential.counter,
      transports: input.credential.transports ?? undefined,
    },
  })
  if (!result.verified) {
    return null
  }
  return { newCounter: result.authenticationInfo.newCounter }
}

// The credential shape verifyPasskeyAuthentication needs, sourced from a DB row. Named fields match
// VerifiedPasskeyRegistration so either can be passed in (the row uses `credentialId` for its `id`).
type StoredPasskeyCredential = {
  credentialId: string
  publicKey: string
  counter: number
  transports: AuthenticatorTransportFuture[] | null
}

// Adapts a persisted row into the credential shape the verify step consumes (column `id` ➜ field
// `credentialId`), so callers never reach into row internals.
export const toStoredPasskeyCredential = (row: WebauthnCredential): StoredPasskeyCredential => ({
  credentialId: row.id,
  publicKey: row.publicKey,
  counter: row.counter,
  transports: row.transports,
})

// --- credential store ----------------------------------------------------------------------------

// Persists a freshly verified passkey. `name` is the user's device label, null until they set one.
export const storePasskey = async (input: {
  userId: string
  registration: VerifiedPasskeyRegistration
  name: string | null
}): Promise<void> => {
  await db.insert(webauthnCredentials).values({
    id: input.registration.credentialId,
    userId: input.userId,
    publicKey: input.registration.publicKey,
    counter: input.registration.counter,
    transports: input.registration.transports,
    deviceType: input.registration.deviceType,
    backedUp: input.registration.backedUp,
    name: input.name,
  })
}

// Every passkey a user has enrolled — feeds excludeCredentials (enroll), allowCredentials (login),
// and the Security page list.
export const listPasskeys = (userId: string): Promise<WebauthnCredential[]> =>
  db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))

// One credential by its id (the value an assertion reports), or null. The login step looks the
// stored public key up this way to verify the signature against it.
export const getPasskey = async (credentialId: string): Promise<WebauthnCredential | null> => {
  const [row] = await db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.id, credentialId))
    .limit(1)
  return row ?? null
}

// How many passkeys a user has. The delete path needs the number (to refuse removing the last one),
// and the login gate is derived from it — so "2FA enabled" stays a count, never a stored boolean.
export const countPasskeys = async (userId: string): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  return row?.total ?? 0
}

// The login gate: does this user have 2FA on? Derived from the count, so there's nothing to keep in sync.
export const hasEnrolledPasskey = async (userId: string): Promise<boolean> =>
  (await countPasskeys(userId)) > 0

// Rename a passkey. Scoped by userId so one user can't relabel another's; returns whether a row matched.
export const renamePasskey = async (
  userId: string,
  credentialId: string,
  name: string,
): Promise<boolean> => {
  const updated = await db
    .update(webauthnCredentials)
    .set({ name })
    .where(and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, userId)))
    .returning({ id: webauthnCredentials.id })
  return updated.length > 0
}

// Remove one passkey. Scoped by userId, so a credential id alone can't delete someone else's key;
// returns whether a row actually matched (false ⇒ unknown id or not this user's).
export const deletePasskey = async (userId: string, credentialId: string): Promise<boolean> => {
  const removed = await db
    .delete(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, credentialId), eq(webauthnCredentials.userId, userId)))
    .returning({ id: webauthnCredentials.id })
  return removed.length > 0
}

// Turn 2FA off entirely. Removes BOTH the passkeys AND their now-orphaned recovery codes, in one
// transaction, so the account can never be left half-disabled (keys gone but stale codes live, or the
// reverse). Gated behind a fresh-factor step-up at the route — this function trusts its caller.
export const disableTwoFactor = async (userId: string): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
  })
}

// After a successful assertion: store the authenticator's new counter and stamp last-used. The
// counter is whatever the library returned — see verifyPasskeyAuthentication on why we don't judge it.
export const touchPasskeyCounter = async (
  credentialId: string,
  newCounter: number,
): Promise<void> => {
  await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(webauthnCredentials.id, credentialId))
}
