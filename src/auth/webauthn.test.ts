import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import { env } from '../lib/env.ts'
import {
  buildPasskeyAuthenticationOptions,
  buildPasskeyRegistrationOptions,
  getPasskey,
  hasEnrolledPasskey,
  listPasskeys,
  storePasskey,
  touchPasskeyCounter,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './webauthn.ts'

// 'internal' = a platform authenticator (Face ID / Touch ID). Reused as a typed value so the union,
// not bare string[], flows through the option builders and the store.
const INTERNAL: AuthenticatorTransportFuture[] = ['internal']

// Minimal but fully-typed browser responses. Their contents don't matter to these tests — the verify
// step is mocked at the boundary — they exist only to satisfy the function signatures honestly.
const fakeRegistrationResponse: RegistrationResponseJSON = {
  id: 'cred-id',
  rawId: 'cred-id',
  response: { clientDataJSON: '', attestationObject: '' },
  clientExtensionResults: {},
  type: 'public-key',
}
const fakeAuthenticationResponse: AuthenticationResponseJSON = {
  id: 'cred-id',
  rawId: 'cred-id',
  response: { clientDataJSON: '', authenticatorData: '', signature: '' },
  clientExtensionResults: {},
  type: 'public-key',
}

describe('webauthn option builders', () => {
  test('registration options carry our RP, a challenge, exclusions, and 2FA flags', async () => {
    const options = await buildPasskeyRegistrationOptions({
      userId: 'user-1',
      userName: 'mara@example.test',
      existingCredentials: [{ id: 'already-enrolled', transports: INTERNAL }],
    })

    expect(options.rp.id).toBe(env.RP_ID)
    expect(options.rp.name).toBe(env.RP_NAME)
    expect(options.challenge.length).toBeGreaterThan(0)
    // The device they already have is excluded so the browser greys it out.
    expect(options.excludeCredentials?.map((cred) => cred.id)).toEqual(['already-enrolled'])
    // Second factor, not passwordless: no discoverable credential, biometric preferred.
    expect(options.authenticatorSelection?.residentKey).toBe('discouraged')
    expect(options.authenticatorSelection?.userVerification).toBe('preferred')
    expect(options.attestation).toBe('none')
  })

  test('authentication options carry the RP, a challenge, and the allowed credentials', async () => {
    const options = await buildPasskeyAuthenticationOptions({
      allowCredentials: [{ id: 'cred-9', transports: INTERNAL }],
    })

    expect(options.rpId).toBe(env.RP_ID)
    expect(options.challenge.length).toBeGreaterThan(0)
    expect(options.allowCredentials?.map((cred) => cred.id)).toEqual(['cred-9'])
    expect(options.userVerification).toBe('preferred')
  })
})

describe('webauthn verify wrappers (library mocked at the boundary)', () => {
  const publicKeyBytes = new Uint8Array([1, 2, 3, 4])

  test('registration: a non-verifying response becomes null', async () => {
    const verifyFails: typeof verifyRegistrationResponse = async () => ({ verified: false })
    const result = await verifyPasskeyRegistration(
      { response: fakeRegistrationResponse, expectedChallenge: 'challenge' },
      verifyFails,
    )
    expect(result).toBeNull()
  })

  test('registration: a verified response is normalized and the public key round-trips', async () => {
    const verifyOk: typeof verifyRegistrationResponse = async () => ({
      verified: true,
      registrationInfo: {
        fmt: 'none',
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: {
          id: 'new-cred',
          publicKey: publicKeyBytes,
          counter: 7,
          transports: ['internal'],
        },
        credentialType: 'public-key',
        attestationObject: new Uint8Array([]),
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'http://localhost:3000',
      },
    })

    const result = await verifyPasskeyRegistration(
      { response: fakeRegistrationResponse, expectedChallenge: 'challenge' },
      verifyOk,
    )

    expect(result?.credentialId).toBe('new-cred')
    expect(result?.counter).toBe(7)
    expect(result?.deviceType).toBe('multiDevice')
    expect(result?.backedUp).toBe(true)
    expect(result?.transports).toEqual(['internal'])
    // The bytes are stored as base64url text; decoding must yield the original key back.
    expect(result && isoBase64URL.toBuffer(result.publicKey)).toEqual(publicKeyBytes)
  })

  test('authentication: passes the decoded key + our origin/RP to the library and returns the counter', async () => {
    let captured: Parameters<typeof verifyAuthenticationResponse>[0] | undefined
    const verifyOk: typeof verifyAuthenticationResponse = async (args) => {
      captured = args
      return {
        verified: true,
        authenticationInfo: {
          credentialID: 'stored-cred',
          newCounter: 9,
          userVerified: true,
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
          origin: 'http://localhost:3000',
          rpID: env.RP_ID,
        },
      }
    }

    const result = await verifyPasskeyAuthentication(
      {
        response: fakeAuthenticationResponse,
        expectedChallenge: 'challenge',
        credential: {
          credentialId: 'stored-cred',
          publicKey: isoBase64URL.fromBuffer(publicKeyBytes),
          counter: 3,
          transports: INTERNAL,
        },
      },
      verifyOk,
    )

    expect(result).toEqual({ newCounter: 9 })
    expect(captured?.expectedRPID).toBe(env.RP_ID)
    expect(captured?.expectedOrigin).toBe('http://localhost:3000')
    // The stored base64url key is decoded back to bytes before it reaches the library.
    expect(captured?.credential.publicKey).toEqual(publicKeyBytes)
    expect(captured?.credential.counter).toBe(3)
  })

  test('authentication: a non-verifying assertion becomes null', async () => {
    const verifyFails: typeof verifyAuthenticationResponse = async () => ({
      verified: false,
      authenticationInfo: {
        credentialID: 'stored-cred',
        newCounter: 0,
        userVerified: false,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'http://localhost:3000',
        rpID: env.RP_ID,
      },
    })

    const result = await verifyPasskeyAuthentication(
      {
        response: fakeAuthenticationResponse,
        expectedChallenge: 'challenge',
        credential: {
          credentialId: 'stored-cred',
          publicKey: isoBase64URL.fromBuffer(publicKeyBytes),
          counter: 3,
          transports: INTERNAL,
        },
      },
      verifyFails,
    )
    expect(result).toBeNull()
  })
})

describe('passkey store', () => {
  // Integration — hits the dockerized Postgres. Throwaway user, cleaned up after (cascade removes
  // its credentials).
  const testEmail = `webauthn-store-${randomUUID()}@example.test`
  let userId = ''

  beforeAll(async () => {
    const [user] = await db.insert(users).values({ email: testEmail }).returning()
    if (user === undefined) {
      throw new Error('failed to seed test user')
    }
    userId = user.id
  })

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId))
  })

  test('a stored passkey round-trips and flips the user to enrolled', async () => {
    expect(await hasEnrolledPasskey(userId)).toBe(false)

    const credentialId = `cred-${randomUUID()}`
    const publicKey = isoBase64URL.fromBuffer(new Uint8Array([5, 6, 7, 8]))
    await storePasskey({
      userId,
      registration: {
        credentialId,
        publicKey,
        counter: 0,
        transports: INTERNAL,
        deviceType: 'multiDevice',
        backedUp: true,
      },
      name: 'Test iPhone',
    })

    const fetched = await getPasskey(credentialId)
    expect(fetched?.userId).toBe(userId)
    expect(fetched?.publicKey).toBe(publicKey)
    expect(fetched?.name).toBe('Test iPhone')
    expect(fetched?.transports).toEqual(['internal'])

    expect((await listPasskeys(userId)).map((cred) => cred.id)).toContain(credentialId)
    expect(await hasEnrolledPasskey(userId)).toBe(true)
  })

  test('touchPasskeyCounter persists the new counter and stamps last-used', async () => {
    const credentialId = `cred-${randomUUID()}`
    await storePasskey({
      userId,
      registration: {
        credentialId,
        publicKey: isoBase64URL.fromBuffer(new Uint8Array([1])),
        counter: 0,
        transports: null,
        deviceType: 'singleDevice',
        backedUp: false,
      },
      name: null,
    })

    await touchPasskeyCounter(credentialId, 42)

    const fetched = await getPasskey(credentialId)
    expect(fetched?.counter).toBe(42)
    expect(fetched?.lastUsedAt).not.toBeNull()
  })

  test('an unknown credential id resolves to null', async () => {
    expect(await getPasskey(`missing-${randomUUID()}`)).toBeNull()
  })
})
