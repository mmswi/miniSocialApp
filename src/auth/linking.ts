import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { isUniqueViolation } from '../db/errors.ts'
import { AUTH_PROVIDERS, accounts } from '../db/schema.ts'
import { conflict } from '../lib/errors.ts'
import type { GoogleClaims } from './oauth.ts'

// Attaches a Google identity to an ALREADY-SIGNED-IN user — the manual half of account linking, and
// the resolution path for signInWithGoogle's "sign in with your password to link Google" prompt.
//
// No email match is required here, and that is deliberate. The auto-link in google-auth.ts must guard
// against takeover because it runs for an ANONYMOUS caller — it can't tell the real owner from an
// attacker, so it only links when both emails are verified AND equal. This function runs only after
// the caller has proven BOTH ends: a valid session (they own this local account) and a completed OAuth
// exchange (they control this Google account). Requiring the emails to match would defeat the only
// reason manual linking exists — connecting a Google account whose email differs from, or isn't
// verified against, the local one.
export const linkGoogleAccount = async (input: {
  userId: string
  claims: GoogleClaims
}): Promise<void> => {
  const { userId, claims } = input

  // Is this Google identity already spoken for?
  const [existingLink] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, AUTH_PROVIDERS.google),
        eq(accounts.providerUid, claims.googleUserId),
      ),
    )
    .limit(1)
  if (existingLink !== undefined) {
    // Already this user's → linking again is a no-op success. Someone else's → refuse: a Google
    // identity belongs to exactly one user, and the signed-in user hasn't proven they own that account.
    if (existingLink.userId === userId) {
      return
    }
    throw conflict(
      'google_already_linked',
      'That Google account is already linked to another user.',
    )
  }

  // One Google identity per user. Best-effort: there's no UNIQUE(user, provider) index behind this, so
  // a double-submit could still slip a second row through — cosmetic, not a security hole. The
  // takeover-critical guarantee is the UNIQUE(provider, provider_uid) index enforced on insert below.
  const [ownGoogleAccount] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, AUTH_PROVIDERS.google), eq(accounts.userId, userId)))
    .limit(1)
  if (ownGoogleAccount !== undefined) {
    throw conflict('google_link_exists', 'Your account already has a linked Google identity.')
  }

  try {
    await db
      .insert(accounts)
      .values({ userId, provider: AUTH_PROVIDERS.google, providerUid: claims.googleUserId })
  } catch (error: unknown) {
    // Race: a concurrent link claimed the same sub between our check and this insert. The UNIQUE index
    // is the real judge — translate its violation into the same clean conflict, never a 500.
    if (isUniqueViolation(error)) {
      throw conflict(
        'google_already_linked',
        'That Google account is already linked to another user.',
      )
    }
    throw error
  }
}
