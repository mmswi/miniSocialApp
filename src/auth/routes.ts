import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { env } from '../lib/env.ts'
import { badRequest, unauthorized } from '../lib/errors.ts'
import {
  OAUTH_LINK_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  SESSION_COOKIE_NAME,
  clearOAuthHandshakeCookies,
  clearOAuthLinkCookie,
  clearSessionCookie,
  setMfaCookie,
  setOAuthHandshakeCookies,
  setOAuthLinkCookie,
  setSessionCookie,
} from './cookies.ts'
import { signInWithGoogle } from './google-auth.ts'
import { linkGoogleAccount } from './linking.ts'
import { createPendingMfa } from './mfa.ts'
import { createGoogleAuthorization, exchangeGoogleCode } from './oauth.ts'
import { loginWithPassword, signupWithPassword } from './password-auth.ts'
import { requestPasswordReset, resetPassword } from './password-reset.ts'
import { AUTH_RATE_LIMITS } from './ratelimit.ts'
import { getLinkedProviders, parseOrThrow, publicUser } from './route-helpers.ts'
import { getSessionUser, revokeSession } from './session.ts'
import { twoFaRoutes } from './twofa-routes.ts'
import { verifyEmailToken } from './verify.ts'

// The one place the new-password rule lives, so signup and reset can never drift apart.
const passwordField = z.string().min(8, 'Password must be at least 8 characters.').max(200)

const signupBody = z.object({
  email: z.string().email(),
  password: passwordField,
  name: z.string().trim().min(1).max(100).optional(),
})

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const forgotPasswordBody = z.object({
  email: z.string().email(),
})

const resetPasswordBody = z.object({
  token: z.string().min(1),
  password: passwordField,
})

const googleCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
})

const verifyQuery = z.object({
  token: z.string().min(1),
})

// Registered under the /auth prefix. Encapsulated as its own plugin; it inherits the app's cookie
// support and error handler from the parent context. Shared route helpers (parseOrThrow, publicUser,
// getLinkedProviders) live in route-helpers.ts so the 2FA plugin reuses the exact same definitions.
export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  // The passkey 2FA flow (enroll + the second-factor login + recovery) is its own plugin, mounted at
  // /auth/2fa. It reuses this context's cookie support, error handler, and rate-limit plugin.
  await app.register(twoFaRoutes, { prefix: '/2fa' })

  app.post('/signup', { config: { rateLimit: AUTH_RATE_LIMITS.signup } }, async (req, reply) => {
    const input = parseOrThrow(signupBody, req.body)
    await signupWithPassword({ email: input.email, password: input.password, name: input.name })
    // Uniform response: byte-identical whether the email was new or already registered. The signal
    // that differs (a verification link vs a "you already have an account" notice) goes to the inbox,
    // which only the address owner can read — so the endpoint itself is no longer an enumeration
    // oracle. As a consequence signup no longer logs you in; that's a separate step (POST /login).
    return reply.code(200).send({ message: 'Check your email to finish signing up.' })
  })

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMITS.login } }, async (req, reply) => {
    const input = parseOrThrow(loginBody, req.body)
    const result = await loginWithPassword({
      email: input.email,
      password: input.password,
      context: { ip: req.ip, userAgent: req.headers['user-agent'] },
    })
    // 2FA user: the password passed but no session is granted yet. Stash a pending-MFA token in the
    // redline_mfa cookie and tell the client to run the passkey step. Deliberately NO session cookie.
    if (result.status === 'mfa_required') {
      const pending = await createPendingMfa({ userId: result.userId })
      setMfaCookie(reply, pending.rawToken, pending.expiresAt)
      return reply.send({ mfaRequired: true })
    }
    setSessionCookie(reply, result.session.rawToken, result.session.expiresAt)
    const linkedProviders = await getLinkedProviders(result.user.id)
    return reply.send({ user: publicUser(result.user, linkedProviders) })
  })

  // Forgot password, step 1: email a reset link. Uniform 200 whether or not that email has a password
  // account — the service only acts when one exists, and reveals nothing here, so the endpoint is no
  // enumeration oracle (mirrors signup A9). The differentiating signal goes to the inbox.
  app.post(
    '/forgot-password',
    { config: { rateLimit: AUTH_RATE_LIMITS.forgotPassword } },
    async (req, reply) => {
      const input = parseOrThrow(forgotPasswordBody, req.body)
      await requestPasswordReset(input.email)
      return reply.code(200).send({
        message: 'If that email has an account, we sent a password reset link.',
      })
    },
  )

  // Forgot password, step 2: consume the emailed token and set the new password. A missing/expired/used
  // token is a clean, distinct 400 (never a 500). On success every session is revoked, so the user
  // re-authenticates with the new password — we deliberately do NOT open a session here.
  app.post(
    '/reset-password',
    { config: { rateLimit: AUTH_RATE_LIMITS.resetPassword } },
    async (req, reply) => {
      const input = parseOrThrow(resetPasswordBody, req.body)
      await resetPassword(input.token, input.password)
      return reply.code(200).send({ message: 'Your password has been reset. You can now log in.' })
    },
  )

  app.post('/logout', async (req, reply) => {
    const rawToken = req.cookies[SESSION_COOKIE_NAME]
    // Idempotent: revoke only if a token was actually presented, but always clear the cookie and
    // answer 204 — a double-logout, or a logout with no session, is success, not an error.
    if (rawToken !== undefined) {
      await revokeSession(rawToken)
    }
    clearSessionCookie(reply)
    return reply.code(204).send()
  })

  app.get('/me', async (req) => {
    const rawToken = req.cookies[SESSION_COOKIE_NAME]
    if (rawToken === undefined) {
      throw unauthorized('not_authenticated', 'Sign in to continue.')
    }
    const active = await getSessionUser(rawToken)
    if (active === null) {
      throw unauthorized('not_authenticated', 'Sign in to continue.')
    }
    const [user] = await db.select().from(users).where(eq(users.id, active.userId)).limit(1)
    if (user === undefined) {
      throw unauthorized('not_authenticated', 'Sign in to continue.')
    }
    const linkedProviders = await getLinkedProviders(user.id)
    return { user: publicUser(user, linkedProviders) }
  })

  // Consumes the link we emailed on signup: marks the email verified and bounces to the app. A
  // missing/unknown/expired token is a clean 400 (distinct codes), never a 500.
  app.get('/verify', { config: { rateLimit: AUTH_RATE_LIMITS.verify } }, async (req, reply) => {
    const query = verifyQuery.safeParse(req.query)
    if (!query.success) {
      throw badRequest('invalid_verification_token', 'This verification link is invalid.')
    }
    await verifyEmailToken(query.data.token)
    return reply.redirect(`${env.APP_URL}/?verified=1`)
  })

  // Step 1 of the OAuth flow: mint state + PKCE verifier, stash them in short-lived cookies, and
  // send the browser to Google's consent screen.
  app.get('/google', { config: { rateLimit: AUTH_RATE_LIMITS.google } }, async (_req, reply) => {
    const { url, state, codeVerifier } = createGoogleAuthorization()
    setOAuthHandshakeCookies(reply, state, codeVerifier)
    // Definitively a sign-in, not a link: clear any marker an abandoned /google/link left behind, so
    // the shared callback can't misread this flow as a link.
    clearOAuthLinkCookie(reply)
    return reply.redirect(url.href)
  })

  // Manual account linking, step 1: a signed-in user attaches their Google identity (the resolution
  // for the "sign in with your password to link Google" prompt). Same handshake as /google, plus the
  // link marker so the shared callback links to THIS user instead of starting a new sign-in.
  app.get(
    '/google/link',
    { config: { rateLimit: AUTH_RATE_LIMITS.google } },
    async (req, reply) => {
      const rawToken = req.cookies[SESSION_COOKIE_NAME]
      const active = rawToken === undefined ? null : await getSessionUser(rawToken)
      if (active === null) {
        throw unauthorized('not_authenticated', 'Sign in before linking a Google account.')
      }
      const { url, state, codeVerifier } = createGoogleAuthorization()
      setOAuthHandshakeCookies(reply, state, codeVerifier)
      setOAuthLinkCookie(reply)
      return reply.redirect(url.href)
    },
  )

  // Step 2: Google redirects back here with a one-time code. We verify the handshake, exchange the
  // code for the user's identity, sign them in, and bounce to the app. (Error responses are JSON for
  // now; a browser-facing redirect-to-error-page is frontend work for a later step.)
  app.get(
    '/google/callback',
    { config: { rateLimit: AUTH_RATE_LIMITS.google } },
    async (req, reply) => {
      const query = googleCallbackQuery.safeParse(req.query)
      const cookieState = req.cookies[OAUTH_STATE_COOKIE]
      const codeVerifier = req.cookies[OAUTH_VERIFIER_COOKIE]
      // Read the mode before clearing: did /google or /google/link start this round trip?
      const isLinkFlow = req.cookies[OAUTH_LINK_COOKIE] !== undefined

      // Single-use: clear the handshake cookies (state, verifier, AND the link marker) up front so a
      // replay can't reuse them.
      clearOAuthHandshakeCookies(reply)

      // Both handshake secrets must be present and well-formed, or this callback didn't come from our
      // /google redirect.
      if (!query.success || cookieState === undefined || codeVerifier === undefined) {
        throw badRequest('invalid_oauth_callback', 'Missing or malformed Google sign-in response.')
      }
      // The state from Google must match the one we set (CSRF defense, and the binding that stops an
      // attacker's code from being linked into a victim's account). PKCE is enforced by Google against
      // the verifier during the code exchange below.
      if (query.data.state !== cookieState) {
        throw badRequest(
          'oauth_state_mismatch',
          'Google sign-in could not be verified. Please try again.',
        )
      }

      const claims = await exchangeGoogleCode(query.data.code, codeVerifier)

      // Link flow: attach the Google identity to the signed-in user. Re-check the session NOW — the
      // marker cookie only says "this was a link attempt"; the session is what proves WHO is linking,
      // and it may have expired during the round trip to Google's consent screen.
      if (isLinkFlow) {
        const rawToken = req.cookies[SESSION_COOKIE_NAME]
        const active = rawToken === undefined ? null : await getSessionUser(rawToken)
        if (active === null) {
          throw unauthorized('not_authenticated', 'Your session expired. Sign in and link again.')
        }
        await linkGoogleAccount({ userId: active.userId, claims })
        return reply.redirect(`${env.APP_URL}/?linked=google`)
      }

      const { session } = await signInWithGoogle({
        claims,
        context: { ip: req.ip, userAgent: req.headers['user-agent'] },
      })
      setSessionCookie(reply, session.rawToken, session.expiresAt)
      return reply.redirect(env.APP_URL)
    },
  )
}
