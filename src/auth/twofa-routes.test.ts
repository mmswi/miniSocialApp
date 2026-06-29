import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { usersTable } from '../db/schema.ts'
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
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
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

const sessionCookieHeader = (token: string): Record<string, string> => ({
  cookie: `${SESSION_COOKIE_NAME}=${token}`,
})

// A full session for a 2FA user — the only way in is to complete the second factor, so we log in and
// spend the first recovery code. Leaves codes[0] used; codes[1..] are still good for the test body.
const sessionForTwoFactorUser = async (user: {
  email: string
  codes: string[]
}): Promise<string> => {
  const mfaToken = cookieValue(await login(user.email), MFA_COOKIE_NAME)
  if (mfaToken === undefined) {
    throw new Error('expected an mfa cookie after a 2FA login')
  }
  const verified = await app.inject({
    method: 'POST',
    url: '/auth/2fa/recovery/verify',
    headers: mfaCookieHeader(mfaToken),
    payload: { code: user.codes[0] },
  })
  const session = cookieValue(verified, SESSION_COOKIE_NAME)
  if (session === undefined || session === '') {
    throw new Error('expected a session cookie after the second factor')
  }
  return session
}

// Adds a second passkey row directly (a real one needs an authenticator), so the delete-a-non-last
// path has something to remove.
const storeExtraPasskey = async (userId: string): Promise<string> => {
  const credentialId = `cred-${randomUUID()}`
  await storePasskey({
    userId,
    registration: {
      credentialId,
      publicKey: isoBase64URL.fromBuffer(new Uint8Array([9, 9, 9, 9])),
      counter: 0,
      transports: null,
      deviceType: 'singleDevice',
      backedUp: false,
    },
    name: 'Second device',
  })
  return credentialId
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
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

describe('2FA management', () => {
  type CredentialView = { id: string; name: string | null; backedUp: boolean | null }
  type CredentialsResponse = { credentials: CredentialView[]; recoveryCodesRemaining: number }

  const getCredentials = (session: string): Promise<InjectResponse> =>
    app.inject({
      method: 'GET',
      url: '/auth/2fa/credentials',
      headers: sessionCookieHeader(session),
    })

  test('lists passkeys and remaining codes, leaking no key material', async () => {
    const user = await createTwoFactorUser('manage-list')
    const session = await sessionForTwoFactorUser(user) // spends codes[0]

    const response = await getCredentials(session)

    expect(response.statusCode).toBe(200)
    const body = response.json<CredentialsResponse & Record<string, unknown>>()
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]?.id).toBe(user.credentialId)
    expect(body.credentials[0]?.name).toBe('Test device')
    expect(body.recoveryCodesRemaining).toBe(9)
    // The projection must not carry the public key, counter, or userId.
    expect(JSON.stringify(body)).not.toContain('publicKey')
    expect(JSON.stringify(body)).not.toContain('counter')
  })

  test('without a session it is 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/2fa/credentials' })
    expect(response.statusCode).toBe(401)
  })

  test('renames a passkey', async () => {
    const user = await createTwoFactorUser('manage-rename')
    const session = await sessionForTwoFactorUser(user)

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/auth/2fa/credentials/${user.credentialId}`,
      headers: sessionCookieHeader(session),
      payload: { name: 'My Laptop' },
    })
    expect(renamed.statusCode).toBe(200)

    const body = (await getCredentials(session)).json<CredentialsResponse>()
    expect(body.credentials[0]?.name).toBe('My Laptop')
  })

  test('renaming an unknown passkey is 400', async () => {
    const user = await createTwoFactorUser('manage-rename-unknown')
    const session = await sessionForTwoFactorUser(user)

    const response = await app.inject({
      method: 'PATCH',
      url: `/auth/2fa/credentials/cred-${randomUUID()}`,
      headers: sessionCookieHeader(session),
      payload: { name: 'Nope' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('unknown_passkey')
  })

  test('removes a non-last passkey', async () => {
    const user = await createTwoFactorUser('manage-delete')
    const extraId = await storeExtraPasskey(user.userId)
    const session = await sessionForTwoFactorUser(user)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/auth/2fa/credentials/${extraId}`,
      headers: sessionCookieHeader(session),
    })
    expect(removed.statusCode).toBe(200)

    const body = (await getCredentials(session)).json<CredentialsResponse>()
    expect(body.credentials.map((cred) => cred.id)).toEqual([user.credentialId])
  })

  test('refuses to remove the LAST passkey (409 — use disable instead)', async () => {
    const user = await createTwoFactorUser('manage-delete-last')
    const session = await sessionForTwoFactorUser(user)

    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/2fa/credentials/${user.credentialId}`,
      headers: sessionCookieHeader(session),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<{ error: string }>().error).toBe('last_passkey')
  })

  test("cannot delete another user's passkey", async () => {
    const owner = await createTwoFactorUser('manage-owner')
    await storeExtraPasskey(owner.userId) // owner now has 2, so the last-passkey guard won't fire first
    const stranger = await createTwoFactorUser('manage-stranger')
    const session = await sessionForTwoFactorUser(owner)

    const response = await app.inject({
      method: 'DELETE',
      url: `/auth/2fa/credentials/${stranger.credentialId}`,
      headers: sessionCookieHeader(session),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('unknown_passkey')
  })
})

describe('2FA disable (step-up)', () => {
  test('a recovery code disables 2FA — credentials and codes are wiped, login is single-factor again', async () => {
    const user = await createTwoFactorUser('disable-ok')
    const session = await sessionForTwoFactorUser(user) // spends codes[0]

    const disabled = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: sessionCookieHeader(session),
      payload: { recoveryCode: user.codes[1] },
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json<{ disabled: boolean }>().disabled).toBe(true)

    // 2FA is off: login now returns a session straight away, no second factor.
    const relogin = await login(user.email)
    expect(relogin.json<{ mfaRequired?: boolean }>().mfaRequired).toBeUndefined()
    expect(cookieValue(relogin, SESSION_COOKIE_NAME)).toBeDefined()

    // Credentials and recovery codes are both gone.
    const credentials = await app.inject({
      method: 'GET',
      url: '/auth/2fa/credentials',
      headers: sessionCookieHeader(session),
    })
    const body = credentials.json<{ credentials: unknown[]; recoveryCodesRemaining: number }>()
    expect(body.credentials).toHaveLength(0)
    expect(body.recoveryCodesRemaining).toBe(0)
  })

  test('a wrong recovery code is a 403 step_up_failed and leaves 2FA on', async () => {
    const user = await createTwoFactorUser('disable-wrong')
    const session = await sessionForTwoFactorUser(user)

    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: sessionCookieHeader(session),
      payload: { recoveryCode: 'ZZZZ-ZZZZ-ZZZZ' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ error: string }>().error).toBe('step_up_failed')

    // Still on: login still demands the second factor.
    expect((await login(user.email)).json<{ mfaRequired?: boolean }>().mfaRequired).toBe(true)
  })

  test('an assertion with no prior step-up challenge is a 403 (cannot skip the handshake)', async () => {
    const user = await createTwoFactorUser('disable-no-challenge')
    const session = await sessionForTwoFactorUser(user)

    const response = await app.inject({
      method: 'POST',
      url: '/auth/2fa/disable',
      headers: sessionCookieHeader(session),
      payload: { assertion: assertionEnvelope(user.credentialId).response },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<{ error: string }>().error).toBe('step_up_failed')
  })

  test('stepup/options without a session is 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/2fa/stepup/options' })
    expect(response.statusCode).toBe(401)
  })
})
