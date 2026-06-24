import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { type User, users } from '../db/schema.ts'
import { env } from '../lib/env.ts'
import { badRequest, unauthorized } from '../lib/errors.ts'
import {
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  SESSION_COOKIE_NAME,
  clearOAuthHandshakeCookies,
  clearSessionCookie,
  setOAuthHandshakeCookies,
  setSessionCookie,
} from './cookies.ts'
import { signInWithGoogle } from './google-auth.ts'
import { createGoogleAuthorization, exchangeGoogleCode } from './oauth.ts'
import { loginWithPassword, signupWithPassword } from './password-auth.ts'
import { AUTH_RATE_LIMITS } from './ratelimit.ts'
import { getSessionUser, revokeSession } from './session.ts'
import { verifyEmailToken } from './verify.ts'

const signupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  name: z.string().trim().min(1).max(100).optional(),
})

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const googleCallbackQuery = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
})

const verifyQuery = z.object({
  token: z.string().min(1),
})

// zod's structured issues collapse into one clean 400 (the first field message) — never a 500 or a
// leaked stack. Body is `unknown` until it clears the schema, so nothing untyped flows downstream.
const parseOrThrow = <Output>(schema: z.ZodType<Output>, body: unknown): Output => {
  const result = schema.safeParse(body)
  if (!result.success) {
    const firstIssue = result.error.issues[0]
    throw badRequest('invalid_input', firstIssue?.message ?? 'Invalid input.')
  }
  return result.data
}

// The client never sees the password hash or internal columns — only this safe projection.
const publicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified,
  name: user.name,
})

// Registered under the /auth prefix. Encapsulated as its own plugin; it inherits the app's cookie
// support and error handler from the parent context.
export const authRoutes = async (app: FastifyInstance): Promise<void> => {
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
    const { user, session } = await loginWithPassword({
      email: input.email,
      password: input.password,
      context: { ip: req.ip, userAgent: req.headers['user-agent'] },
    })
    setSessionCookie(reply, session.rawToken, session.expiresAt)
    return reply.send({ user: publicUser(user) })
  })

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
    return { user: publicUser(user) }
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
    return reply.redirect(url.href)
  })

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

      // Single-use: clear the handshake cookies up front so a replay can't reuse this state/verifier.
      clearOAuthHandshakeCookies(reply)

      // Both handshake secrets must be present and well-formed, or this callback didn't come from our
      // /google redirect.
      if (!query.success || cookieState === undefined || codeVerifier === undefined) {
        throw badRequest('invalid_oauth_callback', 'Missing or malformed Google sign-in response.')
      }
      // The state from Google must match the one we set (CSRF defense). PKCE is enforced by Google
      // against the verifier during the code exchange below.
      if (query.data.state !== cookieState) {
        throw badRequest(
          'oauth_state_mismatch',
          'Google sign-in could not be verified. Please try again.',
        )
      }

      const claims = await exchangeGoogleCode(query.data.code, codeVerifier)
      const { session } = await signInWithGoogle({
        claims,
        context: { ip: req.ip, userAgent: req.headers['user-agent'] },
      })
      setSessionCookie(reply, session.rawToken, session.expiresAt)
      return reply.redirect(env.APP_URL)
    },
  )
}
