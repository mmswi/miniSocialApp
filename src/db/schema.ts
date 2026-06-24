import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/*
 * Auth data model (eng review A1)
 *
 *   users ──1───<───many── accounts        (password + google both link to ONE user)
 *     │                                      provider_uid = google `sub`, or the email for password
 *     ├──<── sessions                        opaque token; stored HASHED at rest (cookie holds raw)
 *     └──<── email_verification_tokens       single-use, expiring; stored HASHED at rest
 *
 * Account linking = two `accounts` rows pointing at one `users` row.
 * Auto-link only when the email is verified on BOTH sides (see auth/linking).
 */

// The auth methods an account can represent — the single source of truth for the provider value.
// The pgEnum, the column type, and every `provider` comparison across the app derive from these
// names, so a typo'd 'gogle' anywhere is a compile error instead of a silent miss.
export const AUTH_PROVIDERS = { password: 'password', google: 'google' } as const
// ...Id, not AuthProvider: one identifier per meaning across the repo. `AuthProvider` is the React
// auth-context component on the client, so the provider-id union is `AuthProviderId` everywhere.
export type AuthProviderId = (typeof AUTH_PROVIDERS)[keyof typeof AUTH_PROVIDERS]

export const authProvider = pgEnum('auth_provider', [
  AUTH_PROVIDERS.password,
  AUTH_PROVIDERS.google,
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
)

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    providerUid: text('provider_uid').notNull(),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_provider_uid_unique').on(t.provider, t.providerUid),
    index('accounts_user_idx').on(t.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    // sha256(rawToken). The cookie holds the raw token; a DB leak never exposes a usable session.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    // sha256(rawToken); the verification link carries the raw token.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_verification_user_idx').on(t.userId)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Account = typeof accounts.$inferSelect
export type Session = typeof sessions.$inferSelect
