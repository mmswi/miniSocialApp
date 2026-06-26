import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { sessions, users } from '../db/schema.ts'
import { createSession, getSessionUser, revokeAllUserSessions, revokeSession } from './session.ts'
import { hashToken } from './tokens.ts'

// Integration tests — they hit the dockerized Postgres + Redis. Each run uses a throwaway user
// and cleans up after itself so the dev database stays tidy.
const testEmail = `session-test-${randomUUID()}@example.test`
let userId = ''

beforeAll(async () => {
  const [user] = await db.insert(users).values({ email: testEmail }).returning()
  if (user === undefined) {
    throw new Error('failed to seed test user')
  }
  userId = user.id
})

afterAll(async () => {
  // Connection teardown lives in test/setup.ts (once per run). Here we only remove this file's
  // throwaway user; the cascade takes its sessions with it.
  await db.delete(users).where(eq(users.id, userId))
})

describe('sessions', () => {
  test('a created session resolves back to its user', async () => {
    const { rawToken } = await createSession({ userId })
    const active = await getSessionUser(rawToken)
    expect(active?.userId).toBe(userId)
  })

  test('a revoked session no longer resolves', async () => {
    const { rawToken } = await createSession({ userId })
    await revokeSession(rawToken)
    expect(await getSessionUser(rawToken)).toBeNull()
  })

  test('an unknown token resolves to null', async () => {
    expect(await getSessionUser('not-a-real-token')).toBeNull()
  })

  test('an expired session is rejected and cleaned up', async () => {
    const rawToken = `expired-${randomUUID()}`
    await db.insert(sessions).values({
      id: hashToken(rawToken),
      userId,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await getSessionUser(rawToken)).toBeNull()
  })

  test('revokeAllUserSessions clears every row for the user', async () => {
    await createSession({ userId })
    await createSession({ userId })
    await revokeAllUserSessions(userId)
    const remaining = await db.select().from(sessions).where(eq(sessions.userId, userId))
    expect(remaining.length).toBe(0)
  })
})
