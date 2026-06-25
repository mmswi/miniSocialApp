import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import {
  bigint,
  boolean,
  index,
  jsonb,
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

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    // sha256(rawToken); the reset link carries the raw token. Single-use and short-lived (1h) — a
    // higher-risk action than email verification, so a tighter window. Same hash-at-rest shape.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_user_idx').on(t.userId)],
)

/*
 * Two-factor auth — WebAuthn passkeys (Face ID / Touch ID / security keys), 2FA design M1
 *
 *   users ──1──<── webauthn_credentials      a user may enroll several passkeys
 *     └──1──<── recovery_codes               one batch of single-use, lose-your-phone backup codes
 *
 * "2FA is on" is DERIVED: count(webauthn_credentials WHERE user_id = ?) > 0 — no boolean flag to
 * drift. Disabling 2FA deletes a user's credentials + recovery codes. The challenges these flows
 * sign are ephemeral and live in Redis (like the OAuth state/PKCE handshake), never here.
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    // The credential id the authenticator returns (base64url). Globally unique, so it IS the key —
    // it's what `allowCredentials` lists at login, not a surrogate uuid wrapping it.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // base64url COSE public key. Only the PUBLIC half is ever stored; the private key never leaves
    // the device's secure hardware — that is the whole point of a passkey.
    publicKey: text('public_key').notNull(),
    // Signature counter for clone detection. Store whatever the library returns and let it judge:
    // synced passkeys (iCloud/Google) report 0 forever, so a hand-rolled "must increase" rule would
    // lock every iPhone out.
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    // e.g. ['internal','hybrid']; replayed in allowCredentials so the browser hints the right device.
    // Typed as the library's transport union (not bare string[]) so it round-trips with no cast.
    transports: jsonb('transports').$type<AuthenticatorTransportFuture[]>(),
    // 'singleDevice' | 'multiDevice' — whether this is a synced, backup-eligible passkey.
    deviceType: text('device_type'),
    backedUp: boolean('backed_up'),
    // User-facing label ("iPhone 15") so several passkeys are tellable apart on the Security page.
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('webauthn_credentials_user_idx').on(t.userId)],
)

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    // sha256(rawCode); the raw codes are shown to the user exactly once at enrollment and never
    // stored. High-entropy and single-use — the same hash-at-rest shape as sessions and email tokens.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // NULL = unused. Set (not deleted) when consumed, so the UI can show "N of 10 codes remaining".
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Account = typeof accounts.$inferSelect
export type Session = typeof sessions.$inferSelect
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect
export type RecoveryCode = typeof recoveryCodes.$inferSelect
