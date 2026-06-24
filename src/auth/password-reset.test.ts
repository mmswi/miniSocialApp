import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { AUTH_PROVIDERS, accounts, passwordResetTokens, users } from '../db/schema.ts'
import { sentEmails } from '../lib/email.ts'
import { buildServer } from '../server.ts'
import { SESSION_COOKIE_NAME } from './cookies.ts'
import { generateToken, hashToken } from './tokens.ts'

// Integration tests against the dockerized Postgres + Redis via Fastify `inject` (no socket). Under
// NODE_ENV=test enqueueEmail delivers inline, so the reset link lands in `sentEmails` for us to read.
const app = buildServer()
const createdEmails: string[] = []

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

const password = 'correct horse battery staple'

type InjectResponse = Awaited<ReturnType<typeof app.inject>>

const sessionTokenFrom = (response: InjectResponse): string | undefined =>
  response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value

const signup = (email: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } })

const login = (email: string, withPassword: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: withPassword } })

const forgot = (email: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } })

const reset = (token: string, newPassword: string): Promise<InjectResponse> =>
  app.inject({
    method: 'POST',
    url: '/auth/reset-password',
    payload: { token, password: newPassword },
  })

// The raw reset token from the most recent reset email to this address — throws (failing the test
// with a clear message) if none was sent, so callers get a real string without a non-null assertion.
const requireResetToken = (email: string): string => {
  const token = sentEmails
    .filter((message) => message.to === email && message.subject.includes('Reset'))
    .at(-1)
    ?.text.match(/reset-password\?token=(\S+)/)?.[1]
  if (token === undefined) {
    throw new Error(`expected a reset token in an email to ${email}`)
  }
  return token
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(users).where(inArray(users.email, createdEmails))
  }
  await app.close()
})

describe('POST /auth/forgot-password', () => {
  test('emails a reset link to an address that has a password account', async () => {
    const email = uniqueEmail('forgot-ok')
    await signup(email)
    const sentBefore = sentEmails.length

    const response = await forgot(email)

    expect(response.statusCode).toBe(200)
    const sent = sentEmails.slice(sentBefore).find((message) => message.to === email)
    expect(sent?.subject).toContain('Reset')
    expect(sent?.text).toContain('/reset-password?token=')
  })

  test('an unknown email gets the same 200 and no email (no enumeration)', async () => {
    const email = uniqueEmail('forgot-unknown')
    const sentBefore = sentEmails.length

    const response = await forgot(email)

    expect(response.statusCode).toBe(200)
    expect(sentEmails.slice(sentBefore).some((message) => message.to === email)).toBe(false)
  })

  test('a Google-only account gets the same 200 and no reset email (password accounts only)', async () => {
    // A user with a google identity and NO password account — the deliberate scope boundary.
    const email = uniqueEmail('forgot-google')
    const [user] = await db.insert(users).values({ email, emailVerified: true }).returning()
    if (user === undefined) {
      throw new Error('user insert returned no row')
    }
    await db.insert(accounts).values({
      userId: user.id,
      provider: AUTH_PROVIDERS.google,
      providerUid: `google-${randomUUID()}`,
      passwordHash: null,
    })
    const sentBefore = sentEmails.length

    const response = await forgot(email)

    expect(response.statusCode).toBe(200)
    expect(sentEmails.slice(sentBefore).some((message) => message.to === email)).toBe(false)
  })

  test('the same address answers identically whether or not it has an account', async () => {
    const known = uniqueEmail('forgot-uniform-known')
    await signup(known)
    const unknown = uniqueEmail('forgot-uniform-unknown')

    const knownResponse = await forgot(known)
    const unknownResponse = await forgot(unknown)

    expect(knownResponse.statusCode).toBe(unknownResponse.statusCode)
    expect(knownResponse.body).toBe(unknownResponse.body)
  })
})

describe('POST /auth/reset-password', () => {
  test('sets a new password, kills old sessions, and burns the token (full flow)', async () => {
    const email = uniqueEmail('reset-flow')
    await signup(email)
    const oldSession = sessionTokenFrom(await login(email, password))
    expect(oldSession).toBeDefined()

    await forgot(email)
    const token = requireResetToken(email)

    const newPassword = 'a-brand-new-password-123'
    const response = await reset(token, newPassword)
    expect(response.statusCode).toBe(200)

    // The old password no longer works; the new one does.
    expect((await login(email, password)).statusCode).toBe(401)
    expect((await login(email, newPassword)).statusCode).toBe(200)

    // Every prior session was revoked — the pre-reset cookie no longer authenticates.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${oldSession}` },
    })
    expect(me.statusCode).toBe(401)

    // The token is single-use: replaying it after success is rejected.
    expect((await reset(token, newPassword)).statusCode).toBe(400)
  })

  test('notifies the owner that their password changed', async () => {
    const email = uniqueEmail('reset-notify')
    await signup(email)
    await forgot(email)
    const token = requireResetToken(email)
    const sentBefore = sentEmails.length

    await reset(token, 'another-new-password-123')

    const notice = sentEmails.slice(sentBefore).find((message) => message.to === email)
    expect(notice?.subject).toContain('changed')
  })

  test('an unknown token is a 400 invalid_reset_token', async () => {
    const response = await reset(generateToken(), 'whatever-password-123')
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('invalid_reset_token')
  })

  test('an expired token is rejected and removed, leaving the password unchanged', async () => {
    const email = uniqueEmail('reset-expired')
    await signup(email)
    const [user] = await db
      .select()
      .from(users)
      .where(inArray(users.email, [email]))
      .limit(1)
    if (user === undefined) {
      throw new Error(`expected a user for ${email}`)
    }
    const rawToken = generateToken()
    await db.insert(passwordResetTokens).values({
      id: hashToken(rawToken),
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000),
    })

    const response = await reset(rawToken, 'should-not-apply-123')

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('reset_token_expired')
    // The original password still works — the expired token changed nothing.
    expect((await login(email, password)).statusCode).toBe(200)
  })

  test('a too-short password is rejected with a 400 before any change', async () => {
    const email = uniqueEmail('reset-weak')
    await signup(email)
    await forgot(email)
    const token = requireResetToken(email)

    const response = await reset(token, 'short')

    expect(response.statusCode).toBe(400)
    // The original password still works; the weak attempt didn't consume the token either.
    expect((await login(email, password)).statusCode).toBe(200)
  })

  test('requesting a new link invalidates the previous one', async () => {
    const email = uniqueEmail('reset-reissue')
    await signup(email)
    await forgot(email)
    const firstToken = requireResetToken(email)
    await forgot(email)
    const secondToken = requireResetToken(email)
    expect(firstToken).not.toBe(secondToken)

    // The superseded first link no longer works; the latest one does.
    expect((await reset(firstToken, 'new-password-from-first-1')).statusCode).toBe(400)
    expect((await reset(secondToken, 'new-password-from-second-1')).statusCode).toBe(200)
  })
})
