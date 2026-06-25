import { redis } from '../lib/redis.ts'
import { generateToken, hashToken } from './tokens.ts'

/*
 * The pending-MFA token — the half-authenticated state between "password OK" and "session issued"
 * (2FA design M3)
 *
 * When a 2FA user's password verifies, we do NOT mint a session. We mint a pending-MFA token and
 * stash the ONLY thing the second factor is allowed to trust — the userId — in Redis under its hash.
 * The raw token rides a separate httpOnly cookie (redline_mfa). The 2FA endpoints read the userId
 * back FROM REDIS, never from the request body, so a caller can't drive the second factor for an
 * account that isn't theirs. That invariant is the whole reason this layer exists.
 *
 *   /login (password OK, has passkey)
 *     └─ createPendingMfa(userId)            redis SET mfa:pending:<hash> = {userId, challenge:null}
 *   /2fa/authenticate/options
 *     └─ loadPendingMfa → userId             (build options) → attachPendingMfaChallenge(token, challenge)
 *   /2fa/authenticate/verify  (or recovery)
 *     └─ loadPendingMfa → {userId, challenge} → verify → consumePendingMfa  → createSession
 *
 * Same hash-at-rest shape as sessions: the raw token is 256-bit, so sha256 is the right (fast) hash —
 * nothing to brute-force. A Redis leak yields hashes that key nothing useful without the cookie.
 */

// Bounds the half-authenticated window: long enough to complete the Face ID prompt, short enough that
// a stalled login can't linger. A login that doesn't finish the second factor in 10 minutes restarts.
const PENDING_MFA_TTL_MS = 1000 * 60 * 10
const PENDING_MFA_TTL_SECONDS = PENDING_MFA_TTL_MS / 1000

// What the pending entry holds. `challenge` is null until /2fa/authenticate/options generates one and
// attaches it; the verify step demands that exact challenge back.
type PendingMfa = { userId: string; challenge: string | null }
type CreatedPendingMfa = { rawToken: string; expiresAt: Date }

const pendingKey = (rawToken: string): string => `mfa:pending:${hashToken(rawToken)}`

// Opens a pending login. Returns the RAW token for the caller to set as the redline_mfa cookie, plus
// the expiry to match the cookie's lifetime to the Redis entry's. No session is created here.
export const createPendingMfa = async (input: {
  userId: string
}): Promise<CreatedPendingMfa> => {
  const rawToken = generateToken()
  const value: PendingMfa = { userId: input.userId, challenge: null }
  await redis.set(pendingKey(rawToken), JSON.stringify(value), 'EX', PENDING_MFA_TTL_SECONDS)
  return { rawToken, expiresAt: new Date(Date.now() + PENDING_MFA_TTL_MS) }
}

// Resolves the cookie's raw token to its pending state, or null if missing/expired. The userId here is
// the trusted one — it came from server state at /login, never from the current request.
export const loadPendingMfa = async (rawToken: string): Promise<PendingMfa | null> => {
  const cached = await redis.get(pendingKey(rawToken))
  if (cached === null) {
    return null
  }
  return JSON.parse(cached) as PendingMfa
}

// Records the WebAuthn challenge we just issued onto the pending entry, so verify can demand it back.
// Re-reads the userId from Redis (not from the caller) to preserve the trust invariant, and always
// writes with an EX so the key can never end up without a TTL. A no-op if the entry already lapsed —
// the verify step then sees a null challenge and rejects, which is the correct outcome.
export const attachPendingMfaChallenge = async (
  rawToken: string,
  challenge: string,
): Promise<void> => {
  const existing = await loadPendingMfa(rawToken)
  if (existing === null) {
    return
  }
  const value: PendingMfa = { userId: existing.userId, challenge }
  await redis.set(pendingKey(rawToken), JSON.stringify(value), 'EX', PENDING_MFA_TTL_SECONDS)
}

// Burns the pending entry. Called ONLY after a verified assertion or recovery code — single-use, so a
// completed (or abandoned-and-replayed) second factor can't be reused.
export const consumePendingMfa = (rawToken: string): Promise<number> =>
  redis.del(pendingKey(rawToken))
