import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { type User, accounts, users } from '../db/schema.ts'
import { conflict, unauthorized } from '../lib/errors.ts'
import { hashPassword, isPasswordCorrect } from './password.ts'
import { createSession } from './session.ts'

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

// Postgres reports a UNIQUE violation as SQLSTATE 23505. We let the DB constraint be the race-safe
// arbiter of "email already taken" instead of a check-then-insert two requests could both pass.
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code } = error as { code?: unknown }
  return code === '23505'
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

// Creates the identity (users) + the credential (accounts) atomically, then opens a session.
export const signupWithPassword = async (input: {
  email: string
  password: string
  name?: string
  context?: SessionContext
}): Promise<AuthResult> => {
  const email = normalizeEmail(input.email)
  const passwordHash = await hashPassword(input.password)

  let user: User
  try {
    // One transaction: a user must never exist without the credential row that authenticates them.
    // The UNIQUE indexes on users(email) and accounts(provider, provider_uid) make a duplicate
    // signup fail and roll back here — even under a double-submit race — so we get exactly one user.
    user = await db.transaction(async (tx) => {
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
      return createdUser
    })
  } catch (error: unknown) {
    // KNOWN GAP (A5/A9): a distinct 409 here lets an attacker enumerate registered emails. The
    // no-enumeration fix is a uniform "check your email" response, which needs the email-send path
    // from A5; until that exists this stays a conflict. Tracked by a skipped test in routes.test.ts.
    if (isUniqueViolation(error)) {
      throw conflict('email_taken', 'That email is already registered.')
    }
    throw error
  }

  const session = await createSession({ userId: user.id, ...input.context })
  return { user, session }
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
