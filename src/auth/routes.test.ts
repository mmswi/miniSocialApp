import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { AUTH_PROVIDERS, accounts, users } from '../db/schema.ts'
import { sentEmails } from '../lib/email.ts'
import { buildServer } from '../server.ts'
import { OAUTH_LINK_COOKIE, SESSION_COOKIE_NAME } from './cookies.ts'

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

const login = (email: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })

// Signup no longer logs you in (uniform no-enumeration response), so a test that needs an
// authenticated session does the two steps a real user does: sign up, then log in.
const signupThenLogin = async (email: string): Promise<InjectResponse> => {
  await signup(email)
  return login(email)
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(users).where(inArray(users.email, createdEmails))
  }
  await app.close()
})

describe('POST /auth/signup', () => {
  test('returns a uniform 200 and emails a verification link to a new address', async () => {
    const email = uniqueEmail('signup-ok')
    const sentBefore = sentEmails.length
    const response = await signup(email)

    expect(response.statusCode).toBe(200)
    // Signup no longer logs you in — a taken email has no session to grant, so granting one only on
    // the new path would itself reveal which emails are new.
    expect(sessionTokenFrom(response)).toBeUndefined()
    // The account really was created: a verification link was emailed to this address.
    const verification = sentEmails.slice(sentBefore).find((message) => message.to === email)
    expect(verification?.subject).toContain('Verify')
  })

  test('after signup you log in, and the session authenticates GET /auth/me', async () => {
    const email = uniqueEmail('signup-me')
    const token = sessionTokenFrom(await signupThenLogin(email))
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json<{ user: { email: string } }>().user.email).toBe(email)
  })

  test('a duplicate signup creates no second user and emails "you already have an account"', async () => {
    const email = uniqueEmail('signup-dupe')
    await signup(email)
    const sentBefore = sentEmails.length
    const second = await signup(email)

    expect(second.statusCode).toBe(200)
    // The UNIQUE index held: still exactly one user for this email, no second row from the retry.
    const rows = await db.select().from(users).where(eq(users.email, email))
    expect(rows).toHaveLength(1)
    // The owner is told via their inbox — not via the response — that the account already exists.
    const notice = sentEmails.slice(sentBefore).find((message) => message.to === email)
    expect(notice?.subject).toContain('already have')
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

  // The A9 enumeration fix: a new email and an already-registered one must be indistinguishable from
  // outside. The differentiating signal moved into the inbox (above); the HTTP response carries none.
  test('does not reveal whether an email is already registered (uniform response)', async () => {
    const email = uniqueEmail('signup-enum')
    const fresh = await signup(email) // first time: a new account
    const repeat = await signup(email) // second time: the email is taken

    // Byte-identical status line and body — no new-vs-taken signal in the response.
    expect(repeat.statusCode).toBe(fresh.statusCode)
    expect(repeat.body).toBe(fresh.body)
    // And neither path sets a session cookie; a cookie on only one path would itself be the oracle.
    expect(sessionTokenFrom(fresh)).toBeUndefined()
    expect(sessionTokenFrom(repeat)).toBeUndefined()
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

// Session fixation (A9 rotation half / A7 security case): an attacker who plants a known session id in
// the victim's browser before login must NOT have that id become authenticated after login. Our defense
// is that login always mints a brand-new id via createSession and never adopts the incoming cookie.
describe('session fixation', () => {
  test('login issues a fresh session id and never adopts a client-supplied one', async () => {
    const email = uniqueEmail('fixation')
    await signup(email)

    const plantedToken = `attacker-planted-${randomUUID()}`
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
      headers: { cookie: `${SESSION_COOKIE_NAME}=${plantedToken}` },
    })
    expect(login.statusCode).toBe(200)

    // The issued session is a NEW id, not the one the attacker planted.
    const issuedToken = sessionTokenFrom(login)
    expect(issuedToken).toBeDefined()
    expect(issuedToken).not.toBe(plantedToken)

    // The planted id never became valid — it authenticates nothing.
    const withPlanted = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${plantedToken}` },
    })
    expect(withPlanted.statusCode).toBe(401)

    // Only the freshly issued id does.
    const withIssued = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${issuedToken}` },
    })
    expect(withIssued.statusCode).toBe(200)
  })

  test('two logins for the same user mint different session ids (rotation)', async () => {
    const email = uniqueEmail('fixation-rotate')
    await signup(email)
    const first = sessionTokenFrom(await login(email))
    const second = sessionTokenFrom(await login(email))
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })
})

describe('POST /auth/logout', () => {
  test('revokes the session so the next request is 401', async () => {
    const email = uniqueEmail('logout')
    const token = sessionTokenFrom(await signupThenLogin(email))
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

  // Drives the dashboard's "Connect Google" button: a password-only account reports ['password'], so
  // the UI knows google is NOT linked yet and shows the connect button.
  test('reports the linked sign-in providers', async () => {
    const email = uniqueEmail('me-providers')
    const token = sessionTokenFrom(await signupThenLogin(email))
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json<{ user: { linkedProviders: string[] } }>().user.linkedProviders).toEqual([
      AUTH_PROVIDERS.password,
    ])
  })

  // The exact reported bug: a user with a google identity still saw "Connect Google". Once google is
  // linked, /me must report it so the dashboard hides the button instead of offering a no-op re-link.
  test('reports google once a google identity is linked', async () => {
    const email = uniqueEmail('me-google')
    const token = sessionTokenFrom(await signupThenLogin(email))
    const [user] = await db.select().from(users).where(eq(users.email, email))
    if (user === undefined) {
      throw new Error('expected the signed-up user to exist')
    }
    await db.insert(accounts).values({
      userId: user.id,
      provider: AUTH_PROVIDERS.google,
      providerUid: `google-${randomUUID()}`,
    })

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json<{ user: { linkedProviders: string[] } }>().user.linkedProviders).toContain(
      AUTH_PROVIDERS.google,
    )
  })
})

describe('GET /auth/google/link (manual account linking)', () => {
  test('without a session is 401 — you must be signed in to link', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google/link' })
    expect(res.statusCode).toBe(401)
  })

  test('with a session redirects to Google and sets the link marker', async () => {
    const token = sessionTokenFrom(await signupThenLogin(uniqueEmail('glink')))
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/link',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toContain('accounts.google.com')
    // The marker is what tells the shared callback to link rather than sign in.
    expect(res.cookies.some((cookie) => cookie.name === OAUTH_LINK_COOKIE)).toBe(true)
  })
})
