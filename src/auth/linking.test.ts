import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { accounts, users } from '../db/schema.ts'
import { signInWithGoogle } from './google-auth.ts'
import { linkGoogleAccount } from './linking.ts'
import type { GoogleClaims } from './oauth.ts'

// Integration tests against the dockerized Postgres. We drive linkGoogleAccount with synthetic claims
// — the same shape oauth.ts produces after a real exchange — so every branch (link / idempotent /
// refuse) is covered without a live Google. Throwaway users are cleaned up at the end (cascade takes
// their accounts rows with them).
const createdEmails: string[] = []

const seedUser = async (emailVerified = true): Promise<string> => {
  const email = `link-${randomUUID()}@example.test`
  createdEmails.push(email)
  const [user] = await db.insert(users).values({ email, emailVerified }).returning()
  if (user === undefined) {
    throw new Error('failed to seed test user')
  }
  return user.id
}

// A google claim's email is never stored (accounts has no email column), so these don't need cleanup.
const googleClaims = (overrides: Partial<GoogleClaims> = {}): GoogleClaims => ({
  googleUserId: overrides.googleUserId ?? `google-sub-${randomUUID()}`,
  email: overrides.email ?? `g-${randomUUID()}@gmail.test`,
  emailVerified: overrides.emailVerified ?? true,
  name: overrides.name,
  avatarUrl: overrides.avatarUrl,
})

const googleRowsFor = (userId: string) =>
  db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(users).where(inArray(users.email, createdEmails))
  }
})

describe('linkGoogleAccount', () => {
  test('attaches a google identity to the signed-in user', async () => {
    const userId = await seedUser()
    const claims = googleClaims()
    await linkGoogleAccount({ userId, claims })

    const rows = await googleRowsFor(userId)
    expect(rows.length).toBe(1)
    expect(rows[0]?.providerUid).toBe(claims.googleUserId)
  })

  test('links even when the google email differs from the local email and is unverified', async () => {
    // The whole point of the manual flow: the caller already proved both ends, so no email match is
    // required — exactly the case the auto-link refuses.
    const userId = await seedUser(false) // local email unverified
    await linkGoogleAccount({
      userId,
      claims: googleClaims({ email: `different-${randomUUID()}@gmail.test`, emailVerified: false }),
    })
    expect((await googleRowsFor(userId)).length).toBe(1)
  })

  test('re-linking the same google identity to the same user is an idempotent no-op', async () => {
    const userId = await seedUser()
    const claims = googleClaims()
    await linkGoogleAccount({ userId, claims })
    await linkGoogleAccount({ userId, claims }) // again — must not throw, must not duplicate
    expect((await googleRowsFor(userId)).length).toBe(1)
  })

  test('refuses a google identity already linked to another user', async () => {
    const owner = await seedUser()
    const claims = googleClaims()
    await linkGoogleAccount({ userId: owner, claims })

    const other = await seedUser()
    await expect(linkGoogleAccount({ userId: other, claims })).rejects.toThrow()
    expect((await googleRowsFor(other)).length).toBe(0) // nothing linked to the second user
  })

  test('refuses a second, different google identity on the same user', async () => {
    const userId = await seedUser()
    await linkGoogleAccount({ userId, claims: googleClaims() })
    await expect(linkGoogleAccount({ userId, claims: googleClaims() })).rejects.toThrow()
    expect((await googleRowsFor(userId)).length).toBe(1)
  })

  test('the payoff: after linking, signing in with that Google identity returns the SAME user', async () => {
    // Both halves are proven in isolation above; this locks that they actually connect. Once linked,
    // a future Google sign-in must resolve to the existing account (returning-user path), not mint a new
    // one and not 409 — that's the user-facing promise of the whole feature.
    const userId = await seedUser()
    const claims = googleClaims()
    await linkGoogleAccount({ userId, claims })

    const { user } = await signInWithGoogle({ claims })
    expect(user.id).toBe(userId)
  })
})
