import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../db/client.ts'
import { type User, users } from '../db/schema.ts'
import { badRequest, unauthorized } from '../lib/errors.ts'
import { SESSION_COOKIE_NAME, clearSessionCookie, setSessionCookie } from './cookies.ts'
import { loginWithPassword, signupWithPassword } from './password-auth.ts'
import { getSessionUser, revokeSession } from './session.ts'

const signupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  name: z.string().trim().min(1).max(100).optional(),
})

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
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
  app.post('/signup', async (req, reply) => {
    const input = parseOrThrow(signupBody, req.body)
    const { user, session } = await signupWithPassword({
      email: input.email,
      password: input.password,
      name: input.name,
      context: { ip: req.ip, userAgent: req.headers['user-agent'] },
    })
    setSessionCookie(reply, session.rawToken, session.expiresAt)
    return reply.code(201).send({ user: publicUser(user) })
  })

  app.post('/login', async (req, reply) => {
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
}
