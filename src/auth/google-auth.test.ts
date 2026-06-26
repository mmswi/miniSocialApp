import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { AUTH_PROVIDERS, accountsTable, usersTable } from '../db/schema.ts'
import { signInWithGoogle } from './google-auth.ts'
import type { GoogleClaims } from './oauth.ts'
import { hashPassword } from './password.ts'

// We test the linking logic by handing signInWithGoogle synthetic claims — the same shape oauth.ts
// would produce after a real exchange. That puts every security branch (create / link / refuse) under
// test without needing a live Google. Throwaway emails are cleaned up at the end (cascade takes the
// accounts + sessions with the user).
const createdEmails: string[] = []

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

const claimsFor = (email: string, overrides: Partial<GoogleClaims> = {}): GoogleClaims => ({
  googleUserId: overrides.googleUserId ?? `google-sub-${randomUUID()}`,
  email,
  emailVerified: overrides.emailVerified ?? true,
  name: overrides.name,
  avatarUrl: overrides.avatarUrl,
})

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
  }
})

describe('signInWithGoogle', () => {
  test('a first sign-in creates a user and a linked google account', async () => {
    const claims = claimsFor(uniqueEmail('g-new'), { name: 'Mara' })
    const { user } = await signInWithGoogle({ claims })

    expect(user.email).toBe(claims.email)
    expect(user.emailVerified).toBe(true)
    expect(user.name).toBe('Mara')

    const [linked] = await db
      .select()
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.provider, AUTH_PROVIDERS.google),
          eq(accountsTable.providerUid, claims.googleUserId),
        ),
      )
    expect(linked?.userId).toBe(user.id)
  })

  test('signing in again with the same google id reuses the same user', async () => {
    const claims = claimsFor(uniqueEmail('g-repeat'))
    const first = await signInWithGoogle({ claims })
    const second = await signInWithGoogle({ claims })

    expect(second.user.id).toBe(first.user.id)
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, first.user.id))
    expect(rows.length).toBe(1)
  })

  test('a verified google email auto-links to an existing verified local account', async () => {
    const email = uniqueEmail('g-link')
    const [local] = await db.insert(usersTable).values({ email, emailVerified: true }).returning()
    if (local === undefined) {
      throw new Error('failed to seed local user')
    }
    await db.insert(accountsTable).values({
      userId: local.id,
      provider: AUTH_PROVIDERS.password,
      providerUid: email,
      passwordHash: await hashPassword('a real enough password'),
    })

    const { user } = await signInWithGoogle({ claims: claimsFor(email, { emailVerified: true }) })

    expect(user.id).toBe(local.id) // linked to the SAME user, not a duplicate
    const googleRows = await db
      .select()
      .from(accountsTable)
      .where(
        and(eq(accountsTable.userId, local.id), eq(accountsTable.provider, AUTH_PROVIDERS.google)),
      )
    expect(googleRows.length).toBe(1)
  })

  test('an unverified google email never auto-links (account-takeover guard)', async () => {
    const email = uniqueEmail('g-unverified-google')
    await db.insert(usersTable).values({ email, emailVerified: true }).returning()

    await expect(
      signInWithGoogle({ claims: claimsFor(email, { emailVerified: false }) }),
    ).rejects.toThrow()
  })

  test('a verified google email does NOT auto-link to an unverified local account', async () => {
    const email = uniqueEmail('g-unverified-local')
    await db.insert(usersTable).values({ email, emailVerified: false }).returning()

    await expect(
      signInWithGoogle({ claims: claimsFor(email, { emailVerified: true }) }),
    ).rejects.toThrow()
  })
})
