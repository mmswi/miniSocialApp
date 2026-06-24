import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { isUniqueViolation } from '../db/errors.ts'
import { type User, accounts, users } from '../db/schema.ts'
import { unauthorized } from '../lib/errors.ts'
import { hashPassword, isPasswordCorrect } from './password.ts'
import { createSession } from './session.ts'
import {
  createEmailVerificationToken,
  sendAccountExistsEmail,
  sendVerificationEmail,
} from './verify.ts'

type CreatedSession = { rawToken: string; expiresAt: Date }
type AuthResult = { user: User; session: CreatedSession }
type SessionContext = { ip?: string; userAgent?: string }

// Emails are matched case-insensitively: we store and look them up in one canonical (trimmed,
// lowercased) form, so `Mara@x.com` and `mara@x.com` can never become two separate accounts.
const normalizeEmail = (email: string): string => email.trim().toLowerCase()

// A login must answer identically whether the email is unknown OR the password is wrong — any
// difference turns the endpoint into an oracle that confirms which emails are registered.
const invalidCredentials = (): never => {
  throw unauthorized('invalid_credentials', 'Email or password is incorrect.')
}

// Burned on the unknown-email path so a missing account costs about the same wall-clock as a real
// argon2id verify. Without it, "no such user" returns instantly and "wrong password" takes ~50ms —
// a timing oracle that leaks which emails exist. Memoized so we pay the hash cost at most once.
let timingEqualizerHash: string | undefined
const verifyAgainstDecoy = async (password: string): Promise<void> => {
  if (timingEqualizerHash === undefined) {
    timingEqualizerHash = await hashPassword('timing-equalizer-not-a-real-password')
  }
  await isPasswordCorrect(timingEqualizerHash, password)
}

// Uniform, no-enumeration signup. The response is identical whether the email is new or already
// registered (see the route) — the only differentiating signal goes to the inbox, which just the
// address owner can read. So this returns nothing the caller could leak: it creates the account and
// emails the verification link, or, on a duplicate, emails a "you already have an account" notice.
export const signupWithPassword = async (input: {
  email: string
  password: string
  name?: string
}): Promise<void> => {
  const email = normalizeEmail(input.email)
  // Hash up front, on BOTH paths, even though the duplicate path discards it: argon2id (~50ms) is the
  // dominant cost, so paying it whether or not the email exists keeps signup timing-uniform. A
  // deliberate timing equalizer (like login's verifyAgainstDecoy) — do NOT move it after the insert,
  // or the taken path would skip the hash and become a present-vs-absent timing oracle.
  const passwordHash = await hashPassword(input.password)

  let createdUserId: string
  try {
    // One transaction: a user must never exist without the credential row that authenticates them.
    // The UNIQUE indexes on users(email) and accounts(provider, provider_uid) make a duplicate
    // signup fail and roll back here — even under a double-submit race — so we get exactly one user.
    createdUserId = await db.transaction(async (tx) => {
      const [createdUser] = await tx
        .insert(users)
        .values({ email, name: input.name ?? null })
        .returning()
      if (createdUser === undefined) {
        throw new Error('user insert returned no row')
      }
      await tx.insert(accounts).values({
        userId: createdUser.id,
        provider: 'password',
        providerUid: email,
        passwordHash,
      })
      return createdUser.id
    })
  } catch (error: unknown) {
    // The email is already registered. We must not signal that to the caller — instead we notify the
    // real owner by email, so the endpoint stays uniform and an attacker probing emails learns nothing.
    if (isUniqueViolation(error)) {
      await sendAccountExistsEmail(email)
      return
    }
    throw error
  }

  // New account: email the verification link. Signup deliberately does NOT open a session — a taken
  // email has none to grant, so "sometimes a session" would itself be the oracle we're closing. The
  // user logs in (or follows the verify link) as a separate step. The dev transport just logs the
  // link; in production the send becomes a queued job so a slow mail provider can't fail the signup.
  const verification = await createEmailVerificationToken(createdUserId)
  await sendVerificationEmail(email, verification.rawToken)
}

// Verifies a password credential and, on success, opens a fresh session.
export const loginWithPassword = async (input: {
  email: string
  password: string
  context?: SessionContext
}): Promise<AuthResult> => {
  const email = normalizeEmail(input.email)

  // Scope the lookup to the PASSWORD identity, not the user. A Google-only account has no password
  // hash; it must be indistinguishable from a nonexistent email — same decoy verify, same error.
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, 'password'), eq(accounts.providerUid, email)))
    .limit(1)

  if (account === undefined || account.passwordHash === null) {
    await verifyAgainstDecoy(input.password)
    return invalidCredentials()
  }

  const passwordMatches = await isPasswordCorrect(account.passwordHash, input.password)
  if (!passwordMatches) {
    return invalidCredentials()
  }

  // A brand-new session id on every login is session-fixation defense for free: we never adopt an
  // id the client already holds, so a value an attacker planted pre-login can't survive into the
  // authenticated session.
  const session = await createSession({ userId: account.userId, ...input.context })
  const [user] = await db.select().from(users).where(eq(users.id, account.userId)).limit(1)
  if (user === undefined) {
    throw new Error('account references a missing user')
  }
  return { user, session }
}
