import { redis } from '../lib/redis.ts'

/*
 * Short-lived WebAuthn challenges for flows OTHER than a 2FA login.
 *
 * A login's challenge rides the pending-MFA entry (mfa.ts), because login has no session yet to key
 * on. Enrollment is different: the user is already signed in, so the challenge is keyed by their
 * userId here. (M6's step-up will add a session-keyed variant alongside this.)
 *
 * Single-use by construction: stored when we issue the options, taken with GETDEL at verify so a
 * challenge can be redeemed exactly once and never replayed. Short TTL bounds an abandoned enroll.
 */

const CHALLENGE_TTL_SECONDS = 60 * 5

const registrationChallengeKey = (userId: string): string => `webauthn:challenge:reg:${userId}`

// Stash the challenge we just handed the browser, so register/verify can demand the same one back.
export const storeRegistrationChallenge = async (
  userId: string,
  challenge: string,
): Promise<void> => {
  await redis.set(registrationChallengeKey(userId), challenge, 'EX', CHALLENGE_TTL_SECONDS)
}

// Read-and-delete the challenge atomically (GETDEL): single-use, so a verify can't be replayed and a
// stale challenge can't linger. Null if it was never issued or already taken/expired.
export const takeRegistrationChallenge = (userId: string): Promise<string | null> =>
  redis.getdel(registrationChallengeKey(userId))

// Step-up (M6): proving a fresh factor before a destructive action (disable 2FA / remove last passkey).
// Keyed by sessionId — the user is signed in, and tying the challenge to THIS session stops a challenge
// minted for one session from being redeemed by another.
const stepUpChallengeKey = (sessionId: string): string => `webauthn:challenge:stepup:${sessionId}`

export const storeStepUpChallenge = async (sessionId: string, challenge: string): Promise<void> => {
  await redis.set(stepUpChallengeKey(sessionId), challenge, 'EX', CHALLENGE_TTL_SECONDS)
}

export const takeStepUpChallenge = (sessionId: string): Promise<string | null> =>
  redis.getdel(stepUpChallengeKey(sessionId))
