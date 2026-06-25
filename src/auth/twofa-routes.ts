import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { badRequest, unauthorized } from '../lib/errors.ts'
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
import { storeRegistrationChallenge, takeRegistrationChallenge } from './webauthn-challenge.ts'
import {
  buildPasskeyAuthenticationOptions,
  buildPasskeyRegistrationOptions,
  getPasskey,
  hasEnrolledPasskey,
  listPasskeys,
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

// Resolves the redline_mfa cookie to its pending login, or 401s. The userId it returns is the trusted
// one — written server-side at /login, never read from this request. Every authenticate/recovery
// route starts here, so the second factor is always aimed at the user the password belonged to.
const requirePendingMfa = async (
  rawToken: string | undefined,
): Promise<{ rawToken: string; userId: string; challenge: string | null }> => {
  const pending = rawToken === undefined ? null : await loadPendingMfa(rawToken)
  if (rawToken === undefined || pending === null) {
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
      const recoveryCodes = isFirstPasskey ? await generateRecoveryCodes(active.userId) : undefined
      return { credentialId: verified.credentialId, recoveryCodes }
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

      // The asserted credential must belong to THIS pending user. Looking it up and checking ownership
      // stops a valid assertion for someone else's key from satisfying this account.
      const credential = await getPasskey(body.response.id)
      if (credential === null || credential.userId !== pending.userId) {
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
}
