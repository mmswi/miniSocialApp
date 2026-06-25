import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { buildServer } from '../server.ts'
import { MFA_COOKIE_NAME, SESSION_COOKIE_NAME } from './cookies.ts'
import { generateRecoveryCodes } from './recovery-codes.ts'
import { storePasskey } from './webauthn.ts'

// Integration tests against the dockerized Postgres + Redis via Fastify `inject`. Rate limiting is off
// under NODE_ENV=test (buildServer default). You cannot drive a real authenticator (Face ID) here, so
// the passkey-assertion SUCCESS path is covered at the service layer (webauthn.test.ts); this suite
// proves the route machine via the RECOVERY-CODE path (a full, no-mock 2FA login) plus every gating
// and ownership guard, none of which reach the @simplewebauthn verify.
const app = buildServer()
const createdEmails: string[] = []
const password = 'correct horse battery staple'

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

type InjectResponse = Awaited<ReturnType<typeof app.inject>>

const cookieValue = (response: InjectResponse, name: string): string | undefined =>
  response.cookies.find((cookie) => cookie.name === name)?.value

const signup = (email: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } })

const login = (email: string): Promise<InjectResponse> =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })

const mfaCookieHeader = (token: string): Record<string, string> => ({
  cookie: `${MFA_COOKIE_NAME}=${token}`,
})

// A throwaway, fully-enrolled 2FA user: a password account (so login works), one stored passkey (so
// the login gate trips), and a batch of recovery codes. The passkey row is inserted directly — a real
// one can't be minted without an authenticator.
const createTwoFactorUser = async (
  prefix: string,
): Promise<{ email: string; userId: string; credentialId: string; codes: string[] }> => {
  const email = uniqueEmail(prefix)
  await signup(email)
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (user === undefined) {
    throw new Error(`expected a user for ${email}`)
  }
  const credentialId = `cred-${randomUUID()}`
  await storePasskey({
    userId: user.id,
    registration: {
      credentialId,
      publicKey: isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3, 4])),
      counter: 0,
      transports: ['internal'] as AuthenticatorTransportFuture[],
      deviceType: 'multiDevice',
      backedUp: true,
    },
    name: 'Test device',
  })
  const codes = await generateRecoveryCodes(user.id)
  return { email, userId: user.id, credentialId, codes }
}

// A WebAuthn assertion envelope that clears the z.custom shape check but never reaches the library —
// the routes that use it reject on the credential lookup first.
const assertionEnvelope = (credentialId: string) => ({
  response: {
    id: credentialId,
    rawId: credentialId,
    response: { clientDataJSON: '', authenticatorData: '', signature: '' },
    clientExtensionResults: {},
    type: 'public-key',
  },
})

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(users).where(inArray(users.email, createdEmails))
  }
  await app.close()
})

describe('POST /auth/login with 2FA enrolled', () => {
  test('a 2FA user gets mfaRequired and an mfa cookie — and no session', async () => {
    const { email } = await createTwoFactorUser('login-2fa')

    const response = await login(email)

    expect(response.statusCode).toBe(200)
    expect(response.json<{ mfaRequired?: boolean }>().mfaRequired).toBe(true)
    expect(cookieValue(response, MFA_COOKIE_NAME)).toBeDefined()
    // The whole point: the password alone earns no session.
    expect(cookieValue(response, SESSION_COOKIE_NAME)).toBeUndefined()
  })

  test('a wrong password is invalid_credentials, never mfaRequired', async () => {
    const { email } = await createTwoFactorUser('login-2fa-wrong')

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'the-wrong-password' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('invalid_credentials')
  })

  test('a user with no passkey still logs straight in (no regression)', async () => {
    const email = uniqueEmail('login-no-2fa')
    await signup(email)

    const response = await login(email)

    expect(response.statusCode).toBe(200)
    expect(cookieValue(response, SESSION_COOKIE_NAME)).toBeDefined()
    expect(response.json<{ mfaRequired?: boolean }>().mfaRequired).toBeUndefined()
  })
})

describe('POST /auth/2fa/recovery/verify (the full no-mock 2FA login)', () => {
  test('a recovery code finishes login: session set, mfa cookie cleared, count drops, single-use', async () => {
    const { email, codes } = await createTwoFactorUser('recovery-ok')
    const mfaToken = cookieValue(await login(email), MFA_COOKIE_NAME)
    if (mfaToken === undefined) {
      throw new Error('expected an mfa cookie after a 2FA login')
    }

    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/recovery/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: { code: codes[0] },
    })

    expect(response.statusCode).toBe(200)
    expect(cookieValue(response, SESSION_COOKIE_NAME)).toBeTruthy()
    expect(cookieValue(response, MFA_COOKIE_NAME)).toBe('') // cleared
    expect(response.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9)

    // The pending login is single-use: the same mfa cookie can't be replayed for another session.
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/2fa/recovery/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: { code: codes[1] },
    })
    expect(replay.statusCode).toBe(401)
  })

  test('a wrong recovery code is rejected and does NOT consume the pending login', async () => {
    const { email, codes } = await createTwoFactorUser('recovery-wrong')
    const mfaToken = cookieValue(await login(email), MFA_COOKIE_NAME)
    if (mfaToken === undefined) {
      throw new Error('expected an mfa cookie after a 2FA login')
    }

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/2fa/recovery/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: { code: 'ZZZZ-ZZZZ-ZZZZ' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<{ error: string }>().error).toBe('invalid_recovery_code')

    // The pending login survived the failure — a real code on the same cookie still works.
    const good = await app.inject({
      method: 'POST',
      url: '/auth/2fa/recovery/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: { code: codes[0] },
    })
    expect(good.statusCode).toBe(200)
  })
})

describe('2FA gating and ownership guards', () => {
  test('authenticate/options without an mfa cookie is 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/2fa/authenticate/options' })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('mfa_not_pending')
  })

  test('authenticate/verify before any challenge is issued is 400', async () => {
    const { email } = await createTwoFactorUser('verify-no-challenge')
    const mfaToken = cookieValue(await login(email), MFA_COOKIE_NAME)
    if (mfaToken === undefined) {
      throw new Error('expected an mfa cookie after a 2FA login')
    }

    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/authenticate/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: assertionEnvelope('whatever'),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('mfa_challenge_missing')
  })

  test('authenticate/verify rejects a passkey that belongs to a different user', async () => {
    const victim = await createTwoFactorUser('verify-victim')
    const attacker = await createTwoFactorUser('verify-attacker')
    const mfaToken = cookieValue(await login(victim.email), MFA_COOKIE_NAME)
    if (mfaToken === undefined) {
      throw new Error('expected an mfa cookie after a 2FA login')
    }
    // Issue a real challenge onto the victim's pending login first.
    await app.inject({
      method: 'POST',
      url: '/auth/2fa/authenticate/options',
      headers: mfaCookieHeader(mfaToken),
    })

    // Then present the ATTACKER's credential id against the VICTIM's pending login.
    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/authenticate/verify',
      headers: mfaCookieHeader(mfaToken),
      payload: assertionEnvelope(attacker.credentialId),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('webauthn_unknown_credential')
  })

  test('register/options without a session is 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/2fa/register/options' })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('not_authenticated')
  })

  test('register/verify without a session is 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/register/verify',
      payload: assertionEnvelope('whatever'),
    })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>().error).toBe('not_authenticated')
  })
})
