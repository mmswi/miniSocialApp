import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { buildServer } from '../server.ts'
import { SESSION_COOKIE_NAME } from './cookies.ts'

// Integration tests — they exercise the real /auth routes against the dockerized Postgres + Redis
// through Fastify's in-process `inject` (no socket). Every test uses throwaway emails and the suite
// deletes them afterward so the dev database stays clean.
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

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(users).where(inArray(users.email, createdEmails))
  }
  await app.close()
})

describe('POST /auth/signup', () => {
  test('creates a user and sets a session cookie', async () => {
    const email = uniqueEmail('signup-ok')
    const response = await signup(email)
    expect(response.statusCode).toBe(201)
    const body = response.json<{ user: { email: string; emailVerified: boolean } }>()
    expect(body.user.email).toBe(email)
    expect(body.user.emailVerified).toBe(false)
    expect(sessionTokenFrom(response)).toBeDefined()
  })

  test('the new session authenticates GET /auth/me', async () => {
    const email = uniqueEmail('signup-me')
    const token = sessionTokenFrom(await signup(email))
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json<{ user: { email: string } }>().user.email).toBe(email)
  })

  test('a second signup with the same email is a 409 conflict, not a second user', async () => {
    const email = uniqueEmail('signup-dupe')
    expect((await signup(email)).statusCode).toBe(201)
    const second = await signup(email)
    expect(second.statusCode).toBe(409)
    expect(second.json<{ error: string }>().error).toBe('email_taken')
  })

  test('a too-short password is rejected with a 400 field error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: uniqueEmail('signup-weak'), password: 'short' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('invalid_input')
  })

  test('a malformed email is rejected with a 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'not-an-email', password },
    })
    expect(response.statusCode).toBe(400)
  })

  // KNOWN GAP tracked for A5/A9: until the email-send path exists, a duplicate signup returns a
  // distinct 409, which is an email-enumeration oracle. The fix is a uniform "check your email"
  // response. Skipped (not absent) so the suite reports the gap rather than implying signup is
  // already enumeration-safe.
  test.skip('does not reveal whether an email is already registered (uniform response, needs A5)', () => {
    // Implemented in A5 once signup can send a "you already have an account" email instead of 409.
  })
})

describe('POST /auth/login', () => {
  test('the correct password issues a session', async () => {
    const email = uniqueEmail('login-ok')
    await signup(email)
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    })
    expect(login.statusCode).toBe(200)
    expect(sessionTokenFrom(login)).toBeDefined()
  })

  test('a wrong password is rejected with 401 invalid_credentials', async () => {
    const email = uniqueEmail('login-wrong')
    await signup(email)
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'this is the wrong password' },
    })
    expect(login.statusCode).toBe(401)
    expect(login.json<{ error: string }>().error).toBe('invalid_credentials')
  })

  test('an unknown email gives the exact same answer as a wrong password (no enumeration)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: `nobody-${randomUUID()}@example.test`, password },
    })
    expect(login.statusCode).toBe(401)
    expect(login.json<{ error: string }>().error).toBe('invalid_credentials')
  })
})

describe('POST /auth/logout', () => {
  test('revokes the session so the next request is 401', async () => {
    const email = uniqueEmail('logout')
    const token = sessionTokenFrom(await signup(email))
    const cookie = `${SESSION_COOKIE_NAME}=${token}`

    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200)

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })
    expect(logout.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  test('is idempotent with no session cookie', async () => {
    const logout = await app.inject({ method: 'POST', url: '/auth/logout' })
    expect(logout.statusCode).toBe(204)
  })
})

describe('GET /auth/me', () => {
  test('without a session cookie is 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(response.statusCode).toBe(401)
  })
})
