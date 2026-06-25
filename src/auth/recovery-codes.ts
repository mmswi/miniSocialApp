import { randomInt } from 'node:crypto'
import { and, count, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { recoveryCodes } from '../db/schema.ts'
import { hashToken } from './tokens.ts'

/*
 * Recovery codes — the lose-your-phone backup for passkey 2FA (2FA design M4)
 *
 * A passkey lives in one device's secure hardware. Lose the device and the key is gone, and there's
 * no "reset" because the server never had the private key. Recovery codes are the escape hatch: ten
 * one-time strings, shown ONCE at first enrollment, that substitute for a passkey at login.
 *
 *   first enrollment ── generateRecoveryCodes(userId) ──► 10 raw codes shown once (then unrecoverable)
 *   stuck at 2FA     ── consumeRecoveryCode(userId, code) ──► burns one, lets the login through
 *   security page    ── countRemainingRecoveryCodes(userId) ──► "3 of 10 left"
 *
 * Stored exactly like other secrets here: never in the clear, only as sha256(`${userId}:${code}`).
 * sha256 (not a slow password hash) is right because a code is high-entropy random — nothing to
 * brute-force — and the endpoint is rate-limited on top.
 */

// Unambiguous alphabet: no 0/O/1/I/L, so a code read off paper can't be mistyped into a different
// valid-looking one. 32 symbols × 12 chars = ~60 bits of entropy per code — unguessable, and these
// are single-use and rate-limited besides.
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const RECOVERY_CODE_GROUPS = 3
const RECOVERY_CODE_GROUP_LENGTH = 4
const RECOVERY_CODE_COUNT = 10

// One code, e.g. "A7KM-9QR3-FXP2". randomInt is the unbiased crypto picker (no modulo skew).
const generateRecoveryCode = (): string => {
  const groups = Array.from({ length: RECOVERY_CODE_GROUPS }, () => {
    let group = ''
    for (let i = 0; i < RECOVERY_CODE_GROUP_LENGTH; i += 1) {
      group += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)]
    }
    return group
  })
  return groups.join('-')
}

// Codes are shown grouped with dashes; a human may retype them lower-case, spaced, or without the
// dashes. Canonicalize to one form (UPPERCASE, separators stripped) before hashing, so the stored
// hash and the typed-back code always meet in the same shape.
const normalizeRecoveryCode = (rawCode: string): string =>
  rawCode.toUpperCase().replace(/[\s-]/g, '')

// The stored id: sha256 of the user-salted, canonicalized code. Salting with userId makes the hash
// per-user, so codes are looked up only in the context of a known user (the pending-MFA userId).
const recoveryCodeId = (userId: string, normalizedCode: string): string =>
  hashToken(`${userId}:${normalizedCode}`)

// Issues a fresh batch and returns the RAW codes for the caller to show ONCE. Replaces any existing
// batch (so this doubles as "regenerate"). The Set guarantees ten distinct codes — a same-batch
// collision would clash on the PK; at 60 bits it's astronomically unlikely, but cheap to rule out.
export const generateRecoveryCodes = async (userId: string): Promise<string[]> => {
  const codes = new Set<string>()
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(generateRecoveryCode())
  }
  const rawCodes = [...codes]
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId))
    await tx.insert(recoveryCodes).values(
      rawCodes.map((code) => ({
        id: recoveryCodeId(userId, normalizeRecoveryCode(code)),
        userId,
      })),
    )
  })
  return rawCodes
}

// Verify-and-consume one code. Returns true if it was valid and unused (and marks it used), false
// otherwise. The `isNull(usedAt)` in the WHERE makes consumption atomic and single-use: a double
// submit can match the unused row at most once — the loser updates nothing and gets false.
export const consumeRecoveryCode = async (userId: string, rawCode: string): Promise<boolean> => {
  const id = recoveryCodeId(userId, normalizeRecoveryCode(rawCode))
  const consumed = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(eq(recoveryCodes.id, id), eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)),
    )
    .returning({ id: recoveryCodes.id })
  return consumed.length > 0
}

// Unused codes left — drives the "you have N recovery codes remaining" nudge on the Security page.
export const countRemainingRecoveryCodes = async (userId: string): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
  return row?.total ?? 0
}
