import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { WebauthnCredentialRow } from '../db/schema.ts'
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.ts'
import { MFA_COOKIE_NAME, clearMfaCookie, setSessionCookie } from './cookies.ts'
import { attachPendingMfaChallenge, consumePendingMfa, loadPendingMfa } from './mfa.ts'
import { AUTH_RATE_LIMITS } from './ratelimit.ts'
import {
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  generateRecoveryCodes,
} from './recovery-codes.ts'
import {
  getLinkedProviders,
  loadUserOrThrow,
  parseOrThrow,
  publicUser,
  requireSessionUser,
} from './route-helpers.ts'
import { createSession } from './session.ts'
import {
  storeRegistrationChallenge,
  storeStepUpChallenge,
  takeRegistrationChallenge,
  takeStepUpChallenge,
} from './webauthn-challenge.ts'
import {
  buildPasskeyAuthenticationOptions,
  buildPasskeyRegistrationOptions,
  countPasskeys,
  deletePasskey,
  disableTwoFactor,
  getPasskey,
  hasEnrolledPasskey,
  listPasskeys,
  renamePasskey,
  storePasskey,
  toStoredPasskeyCredential,
  touchPasskeyCounter,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './webauthn.ts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The browser's WebAuthn responses are large nested objects, and @simplewebauthn is their
// authoritative validator (it checks the signature, flags, CBOR). So we only sanity-check the
// envelope here — obvious garbage becomes a clean 400 — then hand the typed value to the library.
const registrationResponse = z.custom<RegistrationResponseJSON>(
  (value) => isObject(value) && typeof value.id === 'string' && isObject(value.response),
  { message: 'Invalid registration response.' },
)
const authenticationResponse = z.custom<AuthenticationResponseJSON>(
  (value) => isObject(value) && typeof value.id === 'string' && isObject(value.response),
  { message: 'Invalid authentication response.' },
)

const registerVerifyBody = z.object({
  response: registrationResponse,
  // Optional device label, e.g. "iPhone 15"; blank trims away to undefined.
  name: z.string().trim().min(1).max(60).optional(),
})
const authenticateVerifyBody = z.object({ response: authenticationResponse })
const recoveryVerifyBody = z.object({ code: z.string().min(1).max(40) })

const credentialIdParams = z.object({ id: z.string().min(1) })
const renameBody = z.object({ name: z.string().trim().min(1).max(60) })
// Disabling 2FA (or removing the last passkey) needs a FRESH factor: a passkey assertion (proven
// against a step-up challenge) or a recovery code. A valid session is necessary but not sufficient —
// this is what stops a hijacked live session from silently stripping 2FA off.
const disableBody = z.union([
  z.object({ assertion: authenticationResponse }),
  z.object({ recoveryCode: z.string().min(1).max(40) }),
])

// Resolves the redline_mfa cookie to its pending login, or 401s. The userId it returns is the trusted
// one — written server-side at /login, never read from this request. Every authenticate/recovery
// route starts here, so the second factor is always aimed at the user the password belonged to.
const requirePendingMfa = async (
  rawToken: string | undefined,
): Promise<{ rawToken: string; userId: string; challenge: string | null }> => {
  const pending = rawToken === undefined ? null : await loadPendingMfa(rawToken)
  const hasPendingLogin = rawToken !== undefined && pending !== null
  if (!hasPendingLogin) {
    throw unauthorized('mfa_not_pending', 'Your sign-in expired. Start again.')
  }
  return { rawToken, userId: pending.userId, challenge: pending.challenge }
}

// The shared tail of a passed second factor: burn the pending token, drop the MFA cookie, and ONLY
// NOW mint the real session. createSession runs here and nowhere earlier in the 2FA flow.
const finishMfaLogin = async (
  reply: FastifyReply,
  req: FastifyRequest,
  rawMfaToken: string,
  userId: string,
): Promise<{ user: ReturnType<typeof publicUser> }> => {
  await consumePendingMfa(rawMfaToken)
  clearMfaCookie(reply)
  const session = await createSession({
    userId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  })
  setSessionCookie(reply, session.rawToken, session.expiresAt)
  const user = await loadUserOrThrow(userId)
  const linkedProviders = await getLinkedProviders(userId)
  return { user: publicUser(user, linkedProviders) }
}

// The Security page's view of a passkey — never the public key, counter, or userId.
const publicPasskey = (credential: WebauthnCredentialRow) => ({
  id: credential.id,
  name: credential.name,
  backedUp: credential.backedUp,
  createdAt: credential.createdAt,
  lastUsedAt: credential.lastUsedAt,
})

// Proves a FRESH second factor for a step-up action: a passkey assertion (verified against the
// step-up challenge for THIS session) or a recovery code (consumed). Returns whether it was proven.
// userId and sessionId come from the live session, never the request body — so the attacker who only
// holds a hijacked session has nothing fresh to present.
const proveFreshFactor = async (input: {
  userId: string
  sessionId: string
  proof: { assertion: AuthenticationResponseJSON } | { recoveryCode: string }
}): Promise<boolean> => {
  if ('recoveryCode' in input.proof) {
    return consumeRecoveryCode(input.userId, input.proof.recoveryCode)
  }
  const challenge = await takeStepUpChallenge(input.sessionId)
  if (challenge === null) {
    return false
  }
  const credential = await getPasskey(input.proof.assertion.id)
  const isOwnedByUser = credential !== null && credential.userId === input.userId
  if (!isOwnedByUser) {
    return false
  }
  const verified = await verifyPasskeyAuthentication({
    response: input.proof.assertion,
    expectedChallenge: challenge,
    credential: toStoredPasskeyCredential(credential),
  })
  if (verified === null) {
    return false
  }
  await touchPasskeyCounter(credential.id, verified.newCounter)
  return true
}

// Registered under /auth/2fa (the parent auth plugin adds the /auth prefix).
export const twoFaRoutes = async (app: FastifyInstance): Promise<void> => {
  // --- enrollment: the user is already signed in and adds a passkey ---

  app.post(
    '/register/options',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRegister } },
    async (req) => {
      const active = await requireSessionUser(req)
      const user = await loadUserOrThrow(active.userId)
      const existing = await listPasskeys(active.userId)
      const options = await buildPasskeyRegistrationOptions({
        userId: active.userId,
        userName: user.email,
        existingCredentials: existing.map((cred) => ({ id: cred.id, transports: cred.transports })),
      })
      await storeRegistrationChallenge(active.userId, options.challenge)
      return options
    },
  )

  app.post(
    '/register/verify',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRegister } },
    async (req) => {
      const active = await requireSessionUser(req)
      const body = parseOrThrow(registerVerifyBody, req.body)
      const challenge = await takeRegistrationChallenge(active.userId)
      if (challenge === null) {
        throw badRequest('webauthn_challenge_expired', 'Your enrollment expired. Try again.')
      }
      const verified = await verifyPasskeyRegistration({
        response: body.response,
        expectedChallenge: challenge,
      })
      if (verified === null) {
        throw badRequest('webauthn_registration_failed', 'Could not verify that passkey.')
      }
      // The first passkey turns 2FA on — issue recovery codes once, right here, so a user can never be
      // locked out by losing this brand-new device. Check "is first" BEFORE the new row is stored.
      const isFirstPasskey = !(await hasEnrolledPasskey(active.userId))
      await storePasskey({ userId: active.userId, registration: verified, name: body.name ?? null })
      const recoveryCodesTable = isFirstPasskey
        ? await generateRecoveryCodes(active.userId)
        : undefined
      return { credentialId: verified.credentialId, recoveryCodesTable }
    },
  )

  // --- the second factor at login: no session yet, gated only by the redline_mfa cookie ---

  app.post(
    '/authenticate/options',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorAuthenticate } },
    async (req) => {
      const pending = await requirePendingMfa(req.cookies[MFA_COOKIE_NAME])
      const credentials = await listPasskeys(pending.userId)
      const options = await buildPasskeyAuthenticationOptions({
        allowCredentials: credentials.map((cred) => ({ id: cred.id, transports: cred.transports })),
      })
      await attachPendingMfaChallenge(pending.rawToken, options.challenge)
      return options
    },
  )

  app.post(
    '/authenticate/verify',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorAuthenticate } },
    async (req, reply) => {
      const pending = await requirePendingMfa(req.cookies[MFA_COOKIE_NAME])
      if (pending.challenge === null) {
        throw badRequest('mfa_challenge_missing', 'Request a challenge before verifying.')
      }
      const body = parseOrThrow(authenticateVerifyBody, req.body)

      // The asserted credential must belong to THIS pending user — a valid assertion for someone else's
      // key must not satisfy this account. Unknown id and wrong-owner share one error on purpose, so the
      // response never reveals whether that credential id exists for another user.
      const credential = await getPasskey(body.response.id)
      const isOwnedByPendingUser = credential !== null && credential.userId === pending.userId
      if (!isOwnedByPendingUser) {
        throw badRequest('webauthn_unknown_credential', 'That passkey is not registered here.')
      }

      const verified = await verifyPasskeyAuthentication({
        response: body.response,
        expectedChallenge: pending.challenge,
        credential: toStoredPasskeyCredential(credential),
      })
      if (verified === null) {
        throw badRequest('webauthn_authentication_failed', 'Could not verify that passkey.')
      }

      await touchPasskeyCounter(credential.id, verified.newCounter)
      return finishMfaLogin(reply, req, pending.rawToken, pending.userId)
    },
  )

  app.post(
    '/recovery/verify',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRecovery } },
    async (req, reply) => {
      const pending = await requirePendingMfa(req.cookies[MFA_COOKIE_NAME])
      const body = parseOrThrow(recoveryVerifyBody, req.body)
      const consumed = await consumeRecoveryCode(pending.userId, body.code)
      if (!consumed) {
        throw badRequest('invalid_recovery_code', 'That recovery code is invalid or already used.')
      }
      const result = await finishMfaLogin(reply, req, pending.rawToken, pending.userId)
      const recoveryCodesRemaining = await countRemainingRecoveryCodes(pending.userId)
      return { ...result, recoveryCodesRemaining }
    },
  )

  // --- management + step-up: the user is signed in and curating their passkeys ---

  app.get(
    '/credentials',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRegister } },
    async (req) => {
      const active = await requireSessionUser(req)
      const credentials = await listPasskeys(active.userId)
      const recoveryCodesRemaining = await countRemainingRecoveryCodes(active.userId)
      return { credentials: credentials.map(publicPasskey), recoveryCodesRemaining }
    },
  )

  app.patch(
    '/credentials/:id',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRegister } },
    async (req) => {
      const active = await requireSessionUser(req)
      const { id } = parseOrThrow(credentialIdParams, req.params)
      const { name } = parseOrThrow(renameBody, req.body)
      const renamed = await renamePasskey(active.userId, id, name)
      if (!renamed) {
        throw badRequest('unknown_passkey', 'No such passkey.')
      }
      return { id, name }
    },
  )

  app.delete(
    '/credentials/:id',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRegister } },
    async (req) => {
      const active = await requireSessionUser(req)
      const { id } = parseOrThrow(credentialIdParams, req.params)
      // Removing the LAST passkey would drop 2FA to zero — that needs a fresh-factor step-up, so it
      // goes through /disable, not a plain DELETE. A non-last removal keeps 2FA on, so it's allowed.
      if ((await countPasskeys(active.userId)) <= 1) {
        throw conflict('last_passkey', 'This is your last passkey. Disable 2FA to remove it.')
      }
      const removed = await deletePasskey(active.userId, id)
      if (!removed) {
        throw badRequest('unknown_passkey', 'No such passkey.')
      }
      return { id, removed: true }
    },
  )

  // The challenge for a step-up assertion, keyed to this session (see proveFreshFactor).
  app.post(
    '/stepup/options',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorAuthenticate } },
    async (req) => {
      const active = await requireSessionUser(req)
      const credentials = await listPasskeys(active.userId)
      const options = await buildPasskeyAuthenticationOptions({
        allowCredentials: credentials.map((cred) => ({ id: cred.id, transports: cred.transports })),
      })
      await storeStepUpChallenge(active.sessionId, options.challenge)
      return options
    },
  )

  // Turn 2FA off entirely. A valid session is necessary but NOT sufficient — a fresh factor (a passkey
  // assertion or a recovery code) must be proven here, so a hijacked live session alone can't strip it.
  app.post(
    '/disable',
    { config: { rateLimit: AUTH_RATE_LIMITS.twoFactorRecovery } },
    async (req) => {
      const active = await requireSessionUser(req)
      const proof = parseOrThrow(disableBody, req.body)
      const proven = await proveFreshFactor({
        userId: active.userId,
        sessionId: active.sessionId,
        proof,
      })
      if (!proven) {
        throw forbidden('step_up_failed', 'Confirm a passkey or a recovery code to disable 2FA.')
      }
      await disableTwoFactor(active.userId)
      return { disabled: true }
    },
  )
}
