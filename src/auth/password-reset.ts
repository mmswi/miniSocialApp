import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { AUTH_PROVIDERS, accounts, passwordResetTokens, sessions, users } from '../db/schema.ts'
import { env } from '../lib/env.ts'
import { badRequest } from '../lib/errors.ts'
import { enqueueEmail } from '../queue/email-queue.ts'
import { normalizeEmail } from './password-auth.ts'
import { hashPassword } from './password.ts'
import { generateToken, hashToken } from './tokens.ts'

// Reset links are higher-risk than verification links, so they live a tenth as long (1h vs 24h).
const RESET_TTL_MS = 1000 * 60 * 60

// The link we email — it points at the FRONTEND reset page (where the user types a new password), NOT
// the API. Contrast the verification link, which hits GET /auth/verify directly because it has nothing
// to collect. APP_URL is the app origin (the Vite app in dev), so /reset-password is a client route.
const resetLink = (rawToken: string): string => `${env.APP_URL}/reset-password?token=${rawToken}`

// Renders + queues the reset email; the worker delivers it with retries (the email queue, doc 09).
const sendPasswordResetEmail = async (to: string, rawToken: string): Promise<void> => {
  await enqueueEmail({
    to,
    subject: 'Reset your redline password',
    text: `Reset your password by opening this link:\n\n${resetLink(rawToken)}\n\nIt expires in 1 hour. If you didn't request this, you can ignore this email — your password is unchanged.`,
  })
}

// Sent AFTER a successful reset so the real account owner learns of it — the alarm that surfaces a
// malicious reset (an attacker who got in via the email). No link to act on beyond the standard flow.
const sendPasswordChangedEmail = async (to: string): Promise<void> => {
  await enqueueEmail({
    to,
    subject: 'Your redline password was changed',
    text: `Your redline password was just changed.\n\nIf this was you, you're all set. If it wasn't, your account may be compromised — reset your password now at ${env.APP_URL}/forgot-password and contact support.`,
  })
}

// Issues a single-use reset token (only its hash is stored). Drops any prior unused token for this user
// first, so requesting a new link invalidates the old one — only the most recent link ever works.
const createPasswordResetToken = async (userId: string): Promise<{ rawToken: string }> => {
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId))
  const rawToken = generateToken()
  await db.insert(passwordResetTokens).values({
    id: hashToken(rawToken),
    userId,
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  })
  return { rawToken }
}

// Step 1 (forgot): no-enumeration by construction. We only ever act for an email that has a PASSWORD
// account — a Google-only or unknown email silently does nothing — and the route returns a byte-identical
// 200 either way, so the endpoint reveals nothing. The only signal goes to the inbox, which just the
// owner can read. Residual: the real path does an extra token insert + enqueue (~a few ms) the unknown
// path skips — a far weaker timing oracle than login's argon2, accepted at this tier.
export const requestPasswordReset = async (rawEmail: string): Promise<void> => {
  const email = normalizeEmail(rawEmail)
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, AUTH_PROVIDERS.password), eq(accounts.providerUid, email)))
    .limit(1)

  if (account === undefined || account.passwordHash === null) {
    return
  }

  const { rawToken } = await createPasswordResetToken(account.userId)
  // Best-effort, exactly like signup's emails: a queue hiccup must not turn the real-account path into a
  // 500 while the unknown path returns 200 — that gap would reopen the enumeration oracle.
  try {
    await sendPasswordResetEmail(email, rawToken)
  } catch (error: unknown) {
    console.error(
      '[forgot-password] could not queue the reset email; response stays uniform',
      error,
    )
  }
}

// Step 2 (reset): consume the token and set the new password. Distinct, handled 400s for expired vs
// unknown/used — never a 500. A used token was deleted, so it looks identical to one that never existed.
export const resetPassword = async (rawToken: string, newPassword: string): Promise<void> => {
  const id = hashToken(rawToken)
  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.id, id))
    .limit(1)

  if (row === undefined) {
    throw badRequest(
      'invalid_reset_token',
      'This password reset link is invalid or has already been used.',
    )
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.id, id))
    throw badRequest(
      'reset_token_expired',
      'This password reset link has expired. Request a new one.',
    )
  }

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)

  // argon2id is the dominant cost; do it outside the transaction so the txn (and its row locks) stays
  // short. The token is still unconsumed at this point — a crash here just leaves a valid, unused link.
  const passwordHash = await hashPassword(newPassword)

  // One transaction so the reset is all-or-nothing: set the new hash, mark the email verified (clicking
  // the link proves email control), burn the token (single-use), and revoke EVERY session. A crash
  // mid-way must never leave the token spent with the password unchanged (lockout) or the password
  // changed with a reusable token. Revoking sessions is the "I may be compromised" response — every
  // existing login dies. (Cached sessions still lapse within the session cache's 60s TTL, not instantly.)
  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({ passwordHash })
      .where(and(eq(accounts.userId, row.userId), eq(accounts.provider, AUTH_PROVIDERS.password)))
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId))
    await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.id, id))
    await tx.delete(sessions).where(eq(sessions.userId, row.userId))
  })

  if (user !== undefined) {
    try {
      await sendPasswordChangedEmail(user.email)
    } catch (error: unknown) {
      console.error('[reset-password] could not queue the password-changed notice', error)
    }
  }
}
