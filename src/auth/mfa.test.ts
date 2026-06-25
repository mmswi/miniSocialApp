import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { redis } from '../lib/redis.ts'
import {
  attachPendingMfaChallenge,
  consumePendingMfa,
  createPendingMfa,
  loadPendingMfa,
} from './mfa.ts'
import { hashToken } from './tokens.ts'

// Integration — hits the dockerized Redis. The pending entry stores only a userId string, so no DB
// user is needed; a random uuid stands in for one.

describe('pending MFA token', () => {
  test('a created token resolves back to its user, with no challenge yet', async () => {
    const userId = randomUUID()
    const { rawToken, expiresAt } = await createPendingMfa({ userId })

    const pending = await loadPendingMfa(rawToken)
    expect(pending).toEqual({ userId, challenge: null })
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  test('each pending login gets a distinct token', async () => {
    const a = await createPendingMfa({ userId: randomUUID() })
    const b = await createPendingMfa({ userId: randomUUID() })
    expect(a.rawToken).not.toBe(b.rawToken)
  })

  test('an unknown token resolves to null', async () => {
    expect(await loadPendingMfa(`not-a-real-token-${randomUUID()}`)).toBeNull()
  })

  test('the entry carries a bounded TTL — the half-auth window cannot linger forever', async () => {
    const { rawToken } = await createPendingMfa({ userId: randomUUID() })
    const ttl = await redis.ttl(`mfa:pending:${hashToken(rawToken)}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(600)
  })

  test('attaching a challenge records it without losing the user', async () => {
    const userId = randomUUID()
    const { rawToken } = await createPendingMfa({ userId })

    await attachPendingMfaChallenge(rawToken, 'challenge-abc')

    expect(await loadPendingMfa(rawToken)).toEqual({ userId, challenge: 'challenge-abc' })
  })

  test('attaching a challenge to an unknown token is a no-op (nothing is created)', async () => {
    const rawToken = `not-a-real-token-${randomUUID()}`
    await attachPendingMfaChallenge(rawToken, 'challenge-abc')
    expect(await loadPendingMfa(rawToken)).toBeNull()
  })

  test('consuming a token burns it — single use', async () => {
    const { rawToken } = await createPendingMfa({ userId: randomUUID() })
    await consumePendingMfa(rawToken)
    expect(await loadPendingMfa(rawToken)).toBeNull()
  })
})
