import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import {
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  generateRecoveryCodes,
} from './recovery-codes.ts'

// Integration — hits the dockerized Postgres. Throwaway user, cleaned up after (cascade removes its
// codes). generateRecoveryCodes replaces the batch each call, so each test starts from a known set.
const testEmail = `recovery-codes-${randomUUID()}@example.test`
let userId = ''

const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/

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

describe('recovery codes', () => {
  test('generates ten distinct, well-formed codes, all counted as remaining', async () => {
    const codes = await generateRecoveryCodes(userId)

    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10) // all distinct
    for (const code of codes) {
      expect(code).toMatch(CODE_SHAPE)
    }
    expect(await countRemainingRecoveryCodes(userId)).toBe(10)
  })

  test('a valid code works exactly once', async () => {
    const codes = await generateRecoveryCodes(userId)

    expect(await consumeRecoveryCode(userId, codes[0] ?? '')).toBe(true)
    expect(await countRemainingRecoveryCodes(userId)).toBe(9)

    // Single-use: the same code cannot be spent twice.
    expect(await consumeRecoveryCode(userId, codes[0] ?? '')).toBe(false)
    expect(await countRemainingRecoveryCodes(userId)).toBe(9)
  })

  test('an unknown code is rejected and consumes nothing', async () => {
    await generateRecoveryCodes(userId)

    expect(await consumeRecoveryCode(userId, 'ZZZZ-ZZZZ-ZZZZ')).toBe(false)
    expect(await countRemainingRecoveryCodes(userId)).toBe(10)
  })

  test('a code typed lower-case and without dashes still works', async () => {
    const codes = await generateRecoveryCodes(userId)
    const sloppilyTyped = (codes[0] ?? '').toLowerCase().replace(/-/g, '')

    expect(await consumeRecoveryCode(userId, sloppilyTyped)).toBe(true)
  })

  test('regenerating replaces the batch — old codes stop working', async () => {
    const firstBatch = await generateRecoveryCodes(userId)
    const secondBatch = await generateRecoveryCodes(userId)

    expect(await consumeRecoveryCode(userId, firstBatch[0] ?? '')).toBe(false) // old batch is gone
    expect(await consumeRecoveryCode(userId, secondBatch[0] ?? '')).toBe(true)
    expect(await countRemainingRecoveryCodes(userId)).toBe(9)
  })

  test('a user with no codes has zero remaining', async () => {
    const [freshUser] = await db
      .insert(users)
      .values({ email: `recovery-none-${randomUUID()}@example.test` })
      .returning()
    if (freshUser === undefined) {
      throw new Error('failed to seed second test user')
    }

    expect(await countRemainingRecoveryCodes(freshUser.id)).toBe(0)

    await db.delete(users).where(eq(users.id, freshUser.id))
  })
})
