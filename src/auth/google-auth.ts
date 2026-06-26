import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { isUniqueViolation } from '../db/errors.ts'
import { AUTH_PROVIDERS, type User, accounts, users } from '../db/schema.ts'
import { conflict } from '../lib/errors.ts'
import type { GoogleClaims } from './oauth.ts'
import { createSession } from './session.ts'

type CreatedSession = { rawToken: string; expiresAt: Date }
type AuthResult = { user: User; session: CreatedSession }
type SessionContext = { ip?: string; userAgent?: string }

const openSessionFor = async (user: User, context?: SessionContext): Promise<AuthResult> => {
  const session = await createSession({ userId: user.id, ...context })
  return { user, session }
}

const loadUser = async (userId: string): Promise<User> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (user === undefined) {
    throw new Error('google account references a missing user')
  }
  return user
}

// Resolves a Google identity to a session, in three cases: returning user, link to an existing local
// account, or brand-new user.
export const signInWithGoogle = async (input: {
  claims: GoogleClaims
  context?: SessionContext
}): Promise<AuthResult> => {
  const { claims } = input

  // 1. Returning Google user — the `sub` is already linked to a user, so just open a session.
  const [googleAccount] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, AUTH_PROVIDERS.google),
        eq(accounts.providerUid, claims.googleUserId),
      ),
    )
    .limit(1)
  if (googleAccount !== undefined) {
    return openSessionFor(await loadUser(googleAccount.userId), input.context)
  }

  // 2. First time with this Google account, but a local user already owns the email.
  const [existingUser] = await db.select().from(users).where(eq(users.email, claims.email)).limit(1)
  if (existingUser !== undefined) {
    // Account-takeover guard: auto-link ONLY when BOTH sides have a proven email — Google says
    // verified AND the local account is verified. A local account can be created by anyone typing
    // any address at signup, so linking a verified Google login into an *unverified* local account
    // would hand that account to whoever registered the email first. When the guard fails we refuse
    // to link (a deliberate conflict) rather than merge; the manual, signed-in link flow is A6.
    const bothEmailsVerified = claims.emailVerified && existingUser.emailVerified
    if (!bothEmailsVerified) {
      throw conflict(
        'account_exists',
        'An account with this email already exists. Sign in with your password to link Google.',
      )
    }
    await db.insert(accounts).values({
      userId: existingUser.id,
      provider: AUTH_PROVIDERS.google,
      providerUid: claims.googleUserId,
    })
    return openSessionFor(existingUser, input.context)
  }

  // 3. Brand-new person — create the identity and the Google credential together. Google has already
  // verified the email, so the new user inherits that verified state.
  let createdUser: User
  try {
    createdUser = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(users)
        .values({
          email: claims.email,
          emailVerified: claims.emailVerified,
          name: claims.name ?? null,
          avatarUrl: claims.avatarUrl ?? null,
        })
        .returning()
      if (inserted === undefined) {
        throw new Error('user insert returned no row')
      }
      await tx.insert(accounts).values({
        userId: inserted.id,
        provider: AUTH_PROVIDERS.google,
        providerUid: claims.googleUserId,
      })
      return inserted
    })
  } catch (error: unknown) {
    // Race: two valid callbacks for the SAME new Google id landing together — rarer than a form
    // double-submit, since each needs its own one-time code. The UNIQUE index on
    // accounts(provider, provider_uid) lets exactly one insert win; the loser re-resolves here as a
    // returning user (the row now exists), mirroring the duplicate-signup handling in password-auth.
    if (isUniqueViolation(error)) {
      const [racedAccount] = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, AUTH_PROVIDERS.google),
            eq(accounts.providerUid, claims.googleUserId),
          ),
        )
        .limit(1)
      if (racedAccount !== undefined) {
        return openSessionFor(await loadUser(racedAccount.userId), input.context)
      }
    }
    throw error
  }
  return openSessionFor(createdUser, input.context)
}
