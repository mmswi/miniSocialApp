import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { db } from '../db/client.ts'
import { type AuthProviderId, type User, accounts, users } from '../db/schema.ts'
import { badRequest, unauthorized } from '../lib/errors.ts'
import { SESSION_COOKIE_NAME } from './cookies.ts'
import { getSessionUser } from './session.ts'

// Shared route plumbing, factored out of routes.ts so the 2FA plugin (twofa-routes.ts) reuses the
// exact same definitions — most importantly publicUser, a security projection that must exist in one
// place so a leaked column can't slip into one route's response but not another's.

// zod's structured issues collapse into one clean 400 (the first field message) — never a 500 or a
// leaked stack. Body is `unknown` until it clears the schema, so nothing untyped flows downstream.
export const parseOrThrow = <Output>(schema: z.ZodType<Output>, body: unknown): Output => {
  const result = schema.safeParse(body)
  if (!result.success) {
    const firstIssue = result.error.issues[0]
    throw badRequest('invalid_input', firstIssue?.message ?? 'Invalid input.')
  }
  return result.data
}

// Which sign-in methods this user has set up. The client uses it to show "Connect Google" only when
// google isn't already linked — so someone who signed in WITH Google never sees a button offering to
// connect the very account they just used.
export const getLinkedProviders = async (userId: string): Promise<AuthProviderId[]> => {
  const rows = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.userId, userId))
  return rows.map((row) => row.provider)
}

// The client never sees the password hash or internal columns — only this safe projection, plus the
// set of linked providers so the UI can reflect which sign-in methods are connected.
export const publicUser = (user: User, linkedProviders: AuthProviderId[]) => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified,
  name: user.name,
  linkedProviders,
})

// Resolve the caller's session to its user, or throw 401. The one place the cookie → session check
// lives, so every authenticated route rejects a missing/expired session identically.
export const requireSessionUser = async (
  req: FastifyRequest,
): Promise<{ userId: string; sessionId: string }> => {
  const rawToken = req.cookies[SESSION_COOKIE_NAME]
  const active = rawToken === undefined ? null : await getSessionUser(rawToken)
  if (active === null) {
    throw unauthorized('not_authenticated', 'Sign in to continue.')
  }
  return active
}

// Load the full user row for an id we already trust (from a session or a verified pending-MFA token).
// A missing row means the session points at a deleted user — treat that as not-authenticated.
export const loadUserOrThrow = async (userId: string): Promise<User> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (user === undefined) {
    throw unauthorized('not_authenticated', 'Sign in to continue.')
  }
  return user
}
