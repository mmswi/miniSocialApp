import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { emailVerificationTokens, users } from '../db/schema.ts'
import { sendEmail } from '../lib/email.ts'
import { env } from '../lib/env.ts'
import { badRequest } from '../lib/errors.ts'
import { generateToken, hashToken } from './tokens.ts'

const VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

type IssuedToken = { rawToken: string; expiresAt: Date }

// Issues a single-use email-verification token. Only the sha256 hash is stored (the id column); the
// raw token rides in the emailed link, so a DB leak never yields a usable link — same shape as sessions.
export const createEmailVerificationToken = async (userId: string): Promise<IssuedToken> => {
  const rawToken = generateToken()
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS)
  await db.insert(emailVerificationTokens).values({
    id: hashToken(rawToken),
    userId,
    expiresAt,
  })
  return { rawToken, expiresAt }
}

// Consumes a verification token: marks the user verified and deletes the token. Distinct, handled
// errors for expired vs unknown/used — never a 500.
export const verifyEmailToken = async (rawToken: string): Promise<{ userId: string }> => {
  const id = hashToken(rawToken)
  const [row] = await db
    .select()
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.id, id))
    .limit(1)

  // Unknown and already-used look identical: a consumed token was deleted, so it has no row. That's
  // intentional — a used link gives the same answer as one that never existed, so neither is an oracle.
  if (row === undefined) {
    throw badRequest(
      'invalid_verification_token',
      'This verification link is invalid or has already been used.',
    )
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, id))
    throw badRequest(
      'verification_expired',
      'This verification link has expired. Request a new one.',
    )
  }

  // Flip the flag and burn the token together, so a token can never be replayed after it succeeds.
  await db.transaction(async (tx) => {
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId))
    await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, id))
  })
  return { userId: row.userId }
}

// The link we email. Points straight at the verify endpoint; clicking it lands on GET /auth/verify.
const verificationLink = (rawToken: string): string =>
  `${env.APP_URL}/auth/verify?token=${rawToken}`

export const sendVerificationEmail = async (to: string, rawToken: string): Promise<void> => {
  await sendEmail({
    to,
    subject: 'Verify your email for redline',
    text: `Confirm your email by opening this link:\n\n${verificationLink(rawToken)}\n\nIt expires in 24 hours.`,
  })
}
