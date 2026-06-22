import { describe, expect, test } from 'bun:test'
import { generateToken, hashToken } from './tokens.ts'

describe('tokens', () => {
  test('each token is unique and high-entropy', () => {
    const first = generateToken()
    const second = generateToken()
    expect(first).not.toBe(second)
    // 32 random bytes -> 43 base64url chars.
    expect(first.length).toBeGreaterThanOrEqual(43)
  })

  test('hashing is deterministic and never returns the raw token', () => {
    const raw = generateToken()
    expect(hashToken(raw)).toBe(hashToken(raw))
    expect(hashToken(raw)).not.toBe(raw)
  })
})
