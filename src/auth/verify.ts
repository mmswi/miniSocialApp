import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { emailVerificationTokensTable, usersTable } from '../db/schema.ts'
import { env } from '../lib/env.ts'
import { badRequest } from '../lib/errors.ts'
import { enqueueEmail } from '../queue/email-queue.ts'
import { generateToken, hashToken } from './tokens.ts'

const VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

type IssuedToken = { rawToken: string; expiresAt: Date }

// Issues a single-use email-verification token. Only the sha256 hash is stored (the id column); the
// raw token rides in the emailed link, so a DB leak never yields a usable link — same shape as sessions.
export const createEmailVerificationToken = async (userId: string): Promise<IssuedToken> => {
  const rawToken = generateToken()
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS)
  await db.insert(emailVerificationTokensTable).values({
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
    .from(emailVerificationTokensTable)
    .where(eq(emailVerificationTokensTable.id, id))
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
    await db.delete(emailVerificationTokensTable).where(eq(emailVerificationTokensTable.id, id))
    throw badRequest(
      'verification_expired',
      'This verification link has expired. Request a new one.',
    )
  }

  // Flip the flag and burn the token together, so a token can never be replayed after it succeeds.
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ emailVerified: true }).where(eq(usersTable.id, row.userId))
    await tx.delete(emailVerificationTokensTable).where(eq(emailVerificationTokensTable.id, id))
  })
  return { userId: row.userId }
}

// The link we email. Points straight at the verify endpoint; clicking it lands on GET /auth/verify.
const verificationLink = (rawToken: string): string =>
  `${env.APP_URL}/auth/verify?token=${rawToken}`

// Renders the verification message and hands it to the durable queue — the worker does the actual SMTP
// send, with retries, so a transient mail failure here can't lose the link. The raw token rides in the
// job payload because only its hash is stored in the DB; jobs are short-lived and dropped on success.
export const sendVerificationEmail = async (to: string, rawToken: string): Promise<void> => {
  await enqueueEmail({
    to,
    subject: 'Verify your email for redline',
    text: `Confirm your email by opening this link:\n\n${verificationLink(rawToken)}\n\nIt expires in 24 hours.`,
  })
}

// Queued on a duplicate signup INSTEAD of a 409 — the signup response is byte-identical to a fresh one,
// so the endpoint never reveals that an email is registered. Only the real owner, reading this inbox,
// learns a signup was attempted, with a nudge to just log in. No token: there's nothing to verify here.
export const sendAccountExistsEmail = async (to: string): Promise<void> => {
  await enqueueEmail({
    to,
    subject: 'You already have a redline account',
    text: `Someone tried to sign up for redline with this email, but you already have an account.\n\nIf this was you, just log in instead:\n\n${env.APP_URL}/login\n\nIf it wasn't you, you can ignore this email — nothing was created or changed.`,
  })
}
