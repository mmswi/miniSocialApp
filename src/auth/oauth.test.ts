import { afterAll, describe, expect, test } from 'bun:test'
import { buildServer } from '../server.ts'
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from './cookies.ts'

// These cover the parts of the OAuth flow that need NO Google credentials: the redirect we build and
// the handshake we verify. The code-for-tokens exchange needs a live Google round trip, so the logic
// behind it (find-or-create + linking) is tested directly in google-auth.test.ts instead.
const app = buildServer()

afterAll(async () => {
  await app.close()
})

describe('GET /auth/google', () => {
  test('redirects to Google with state + PKCE and sets the handshake cookies', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google' })

    expect(res.statusCode).toBe(302)
    const location = String(res.headers.location)
    expect(location).toContain('accounts.google.com')
    expect(location).toContain('state=')
    expect(location).toContain('code_challenge=')
    expect(location).toContain('code_challenge_method=S256')

    const cookieNames = res.cookies.map((cookie) => cookie.name)
    expect(cookieNames).toContain(OAUTH_STATE_COOKIE)
    expect(cookieNames).toContain(OAUTH_VERIFIER_COOKIE)
  })
})

describe('GET /auth/google/callback', () => {
  test('rejects a state that does not match the cookie (CSRF guard)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=some-code&state=attacker-supplied',
      headers: {
        cookie: `${OAUTH_STATE_COOKIE}=the-real-state; ${OAUTH_VERIFIER_COOKIE}=verifier`,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('oauth_state_mismatch')
  })

  test('rejects when the handshake cookies are missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=some-code&state=some-state',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('invalid_oauth_callback')
  })

  // Coverage boundary: the happy path (exchange code -> claims -> session -> redirect to APP_URL) is
  // covered piecewise (signInWithGoogle unit tests + the rejections above), but the live exchange
  // step needs real Google credentials, so the end-to-end route is not exercised here.
  test.skip('full happy path through the callback needs live Google credentials', () => {
    // Enable once GOOGLE_CLIENT_ID/SECRET point at a real (or mocked) Google in the test env.
  })
})
