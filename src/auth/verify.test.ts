import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { emailVerificationTokens, users } from '../db/schema.ts'
import { sentEmails } from '../lib/email.ts'
import { env } from '../lib/env.ts'
import { buildServer } from '../server.ts'
import { SESSION_COOKIE_NAME } from './cookies.ts'
import { signupWithPassword } from './password-auth.ts'
import { hashToken } from './tokens.ts'
import { createEmailVerificationToken, verifyEmailToken } from './verify.ts'

// Integration tests against the dockerized Postgres. Each test seeds its own throwaway user so verify
// state never bleeds between tests; the suite deletes them all at the end (cascade removes the tokens).
const app = buildServer()
const createdUserIds: string[] = []

const seedUser = async (emailVerified = false): Promise<string> => {
  const email = `verify-${randomUUID()}@example.test`
  const [user] = await db.insert(users).values({ email, emailVerified }).returning()
  if (user === undefined) {
    throw new Error('failed to seed test user')
  }
  createdUserIds.push(user.id)
  return user.id
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await app.close()
})

describe('email verification tokens', () => {
  test('issuing a token stores only its hash, never the raw token', async () => {
    const userId = await seedUser()
    const { rawToken } = await createEmailVerificationToken(userId)

    const [row] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.id, hashToken(rawToken)))
    expect(row?.userId).toBe(userId)
    expect(row?.id).not.toBe(rawToken) // the stored id is the hash, not the link's token
  })

  test('a valid token verifies the user and cannot be reused', async () => {
    const userId = await seedUser()
    const { rawToken } = await createEmailVerificationToken(userId)

    const result = await verifyEmailToken(rawToken)
    expect(result.userId).toBe(userId)

    const [user] = await db.select().from(users).where(eq(users.id, userId))
    expect(user?.emailVerified).toBe(true)

    // Single-use: the row was burned, so a second click fails.
    await expect(verifyEmailToken(rawToken)).rejects.toThrow()
  })

  test('an expired token is rejected, removed, and leaves the user unverified', async () => {
    const userId = await seedUser()
    const rawToken = `expired-${randomUUID()}`
    await db.insert(emailVerificationTokens).values({
      id: hashToken(rawToken),
      userId,
      expiresAt: new Date(Date.now() - 1000),
    })

    await expect(verifyEmailToken(rawToken)).rejects.toThrow()

    const [row] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.id, hashToken(rawToken)))
    expect(row).toBeUndefined()

    const [user] = await db.select().from(users).where(eq(users.id, userId))
    expect(user?.emailVerified).toBe(false)
  })

  test('an unknown token is rejected', async () => {
    await expect(verifyEmailToken(`never-issued-${randomUUID()}`)).rejects.toThrow()
  })

  test('signing up issues exactly one verification token for the new, unverified user', async () => {
    const email = `verify-signup-${randomUUID()}@example.test`
    await signupWithPassword({ email, password: 'a real enough password' })

    // Signup no longer returns the user (uniform no-enumeration response); fetch it by email.
    const [user] = await db.select().from(users).where(eq(users.email, email))
    if (user === undefined) {
      throw new Error('signup did not create the user')
    }
    createdUserIds.push(user.id)

    expect(user.emailVerified).toBe(false)
    const rows = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id))
    expect(rows.length).toBe(1)
  })
})

describe('GET /auth/verify', () => {
  test('consumes the token, verifies the user, and redirects to the app', async () => {
    const userId = await seedUser()
    const { rawToken } = await createEmailVerificationToken(userId)

    const res = await app.inject({ method: 'GET', url: `/auth/verify?token=${rawToken}` })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toContain(env.APP_URL)

    const [user] = await db.select().from(users).where(eq(users.id, userId))
    expect(user?.emailVerified).toBe(true)
  })

  test('without a token is a 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/verify' })
    expect(res.statusCode).toBe(400)
  })

  test('with an unknown token is a 400 invalid_verification_token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/verify?token=garbage-${randomUUID()}`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('invalid_verification_token')
  })

  test('with an empty token is a 400 (malformed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/verify?token=' })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('invalid_verification_token')
  })

  test('with a repeated (array-valued) token is a 400 (malformed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/verify?token=a&token=b' })
    expect(res.statusCode).toBe(400)
  })
})

describe('signup → emailed link → verify → login (end to end)', () => {
  test('a user signs up, verifies via the emailed link, and logs in verified', async () => {
    const email = `e2e-${randomUUID()}@example.test`
    const password = 'a properly long password'

    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    })
    expect(signup.statusCode).toBe(200)
    // Signup returns no user now; look it up by email to drive the rest of the flow.
    const [created] = await db.select().from(users).where(eq(users.email, email))
    if (created === undefined) {
      throw new Error('signup did not create the user')
    }
    const userId = created.id
    createdUserIds.push(userId)

    // Pull the verification link out of the email we "sent" — the only place the raw token exists.
    const message = sentEmails.find((sent) => sent.to === email)
    const rawToken = message?.text.match(/token=(\S+)/)?.[1]
    expect(rawToken).toBeDefined()

    const before = await db.select().from(users).where(eq(users.id, userId))
    expect(before[0]?.emailVerified).toBe(false)

    const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${rawToken}` })
    expect(verify.statusCode).toBe(302)

    const after = await db.select().from(users).where(eq(users.id, userId))
    expect(after[0]?.emailVerified).toBe(true)

    // Login still works, and the session now reports a verified email.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    })
    expect(login.statusCode).toBe(200)
    const sessionToken = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json<{ user: { emailVerified: boolean } }>().user.emailVerified).toBe(true)
  })
})
