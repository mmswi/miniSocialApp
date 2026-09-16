import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import {
  bigint,
  bigserial,
  boolean,
  customType,
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

export const authProviderEnum = pgEnum('auth_provider', [
  AUTH_PROVIDERS.password,
  AUTH_PROVIDERS.google,
])

export const usersTable = pgTable(
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

export const accountsTable = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    providerUid: text('provider_uid').notNull(),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_provider_uid_unique').on(t.provider, t.providerUid),
    index('accounts_user_idx').on(t.userId),
  ],
)

export const sessionsTable = pgTable(
  'sessions',
  {
    // sha256(rawToken). The cookie holds the raw token; a DB leak never exposes a usable session.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

export const emailVerificationTokensTable = pgTable(
  'email_verification_tokens',
  {
    // sha256(rawToken); the verification link carries the raw token.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_verification_user_idx').on(t.userId)],
)

export const passwordResetTokensTable = pgTable(
  'password_reset_tokens',
  {
    // sha256(rawToken); the reset link carries the raw token. Single-use and short-lived (1h) — a
    // higher-risk action than email verification, so a tighter window. Same hash-at-rest shape.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
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
export const webauthnCredentialsTable = pgTable(
  'webauthn_credentials',
  {
    // The credential id the authenticator returns (base64url). Globally unique, so it IS the key —
    // it's what `allowCredentials` lists at login, not a surrogate uuid wrapping it.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
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

export const recoveryCodesTable = pgTable(
  'recovery_codes',
  {
    // sha256(`${userId}:${code}`); the raw codes are shown to the user exactly once at enrollment and
    // never stored. Salting with the userId scopes the hash per user — two users can never collide on
    // this PK, and a leaked row reveals nothing without also knowing whose code it is. High-entropy and
    // single-use, the same hash-at-rest shape as sessions and the email tokens.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    // NULL = unused. Set (not deleted) when consumed, so the UI can show "N of 10 codes remaining".
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
)

/*
 * Documents + two-tier persistence (step 2 — the multiplayer editor)
 *
 *   users ──1──<── documents ──1──<── document_updates   (append-only Yjs update log)
 *
 * A document's live state lives in a CRDT (Y.Doc). We persist it two ways at once:
 *   • every Yjs update is APPENDED to document_updates the instant the sync server receives it —
 *     durable immediately, no "process died before the debounced flush" data-loss window;
 *   • a single worker periodically COMPACTS the un-folded log into documents.snapshot and deletes
 *     EXACTLY the rows it folded (step 2 M4, src/sync/compaction.ts).
 *
 * Loading a doc = snapshot + replay of EVERY row still in document_updates (the un-folded tail). There
 * is no "seq > watermark" filter, on purpose: `seq` is a bigserial assigned at INSERT, but commits land
 * out of order, so a lower seq can still be uncommitted (invisible) when a higher one is already
 * visible. A "fold/delete everything ≤ N" watermark would drop such a late row before it was ever
 * folded — silent data loss, the exact failure the append log exists to prevent. Deleting only the rows
 * we actually folded leaves any late row in the log for the next sweep, and load replays whatever
 * remains. Yjs updates are commutative, so replay order can't corrupt state.
 *
 * Appends are commutative and lock-free, so many sync instances can append concurrently with no leader
 * election; the compactor takes FOR NO KEY UPDATE on the documents row so two overlapping sweeps can't
 * clobber each other's snapshot. That lock mode is chosen so it does NOT conflict with the FK key-share
 * lock an append takes on the parent documents row — a fold never blocks an append, or vice versa.
 *
 * (The DB still has a legacy `snapshot_through` column from migration 0003; it is no longer modeled
 * here because the corrected load path replays the full tail instead of keying off a watermark.)
 *
 * Owner-only for now — teams + the reviewer/editor role matrix arrive at step 4.
 */

// Postgres bytea <-> Uint8Array. Yjs speaks Uint8Array; the postgres-js driver speaks Buffer, so we
// normalize at this one seam: app code never handles a Buffer, the driver never sees a bare Uint8Array.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

export const documentsTable = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('Untitled document'),
    // Compacted Y.Doc state (Y.encodeStateAsUpdate). NULL until the first compaction — a brand-new doc
    // is reconstructed purely from its update log. Loading = this snapshot + replay of every remaining
    // update row; the compactor deletes the rows it folds, so "remaining" is exactly the un-folded tail.
    snapshot: bytea('snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_owner_idx').on(t.ownerId)],
)

export const documentUpdatesTable = pgTable(
  'document_updates',
  {
    // bigserial — the append order IS the replay order. Yjs updates are commutative so order can't
    // corrupt state, but a stable total order keeps replay deterministic and lets the compactor say
    // "snapshot includes through seq N" with a single watermark.
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documentsTable.id, { onDelete: 'cascade' }),
    // One Yjs update (the encoded diff of a single transaction), appended the instant it arrives.
    update: bytea('update').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite (documentId, seq): load and compaction both scan one doc's rows in seq order.
  (t) => [index('document_updates_doc_seq_idx').on(t.documentId, t.seq)],
)

/*
 * Teams — permission groups that share documents (step 4)
 *
 *   users ──1──<── team_members >──many──1── teams   (a user is in many teams; a team has many members)
 *
 * A team is a named group with ONE access level (read | write | delete) — the ceiling on what its
 * members may do to a document shared into it. Sharing documents into teams is a later milestone; this
 * slice just creates teams and their memberships. A member also carries a ROLE (owner | admin | member)
 * that governs the TEAM itself — who may invite, rename, or delete it — orthogonal to the access level.
 *
 * Ownership lives ONLY in the memberships: a team is "owned" by whoever holds an `owner`-role row, not
 * by `teams.created_by_id`. That column is a historical footnote (set null when the creator is deleted),
 * so a team outlives its creator as long as some owner-role member remains.
 */

// A member's authority OVER THE TEAM (invite / rename / delete) — distinct from the access level, which
// is the team's authority over documents. Named once here so the pgEnum, the column, and the rank map in
// teams/authz.ts all derive from these; a typo'd 'admn' anywhere is then a compile error, not a silent
// mis-grant.
export const TEAM_ROLES = { owner: 'owner', admin: 'admin', member: 'member' } as const
export type TeamRole = (typeof TEAM_ROLES)[keyof typeof TEAM_ROLES]

export const teamRoleEnum = pgEnum('team_role', [
  TEAM_ROLES.owner,
  TEAM_ROLES.admin,
  TEAM_ROLES.member,
])

// The team's ceiling on what its members may do to a shared document: read ⊂ write ⊂ delete, an ordered
// superset chain. Not enforced by anything in this slice (it only bites when documents are shared into
// teams, a later milestone); stored now so every team is created with its level from day one.
export const TEAM_ACCESS_LEVELS = { read: 'read', write: 'write', delete: 'delete' } as const
export type TeamAccessLevel = (typeof TEAM_ACCESS_LEVELS)[keyof typeof TEAM_ACCESS_LEVELS]

export const teamAccessLevelEnum = pgEnum('team_access_level', [
  TEAM_ACCESS_LEVELS.read,
  TEAM_ACCESS_LEVELS.write,
  TEAM_ACCESS_LEVELS.delete,
])

export const teamsTable = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  accessLevel: teamAccessLevelEnum('access_level').notNull().default(TEAM_ACCESS_LEVELS.read),
  // Who created the team — a footnote, NOT the authorization (that is an `owner`-role membership row).
  // set null, where every other user FK in this file cascades: deleting the creator must not delete a
  // team other people are still in, so the team survives with created_by_id nulled.
  createdById: uuid('created_by_id').references(() => usersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const teamMembersTable = pgTable(
  'team_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    role: teamRoleEnum('role').notNull().default(TEAM_ROLES.member),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One membership per (team, user): a user can't be in a team twice. The DB is the race-safe arbiter
    // (a duplicate insert is a 23505 the data layer catches — not a check-then-insert two requests race).
    uniqueIndex('team_members_team_user_unique').on(t.teamId, t.userId),
    // "Which teams am I in?" — the sidebar's list — scans by user.
    index('team_members_user_idx').on(t.userId),
  ],
)

// A pending invitation for an email to join a team at a given role. Modeled on email_verification_tokens:
// the PK is sha256(rawToken), so only the hash lives at rest and a DB leak yields no usable invite link —
// the raw token rides in the emailed URL and is the capability. Scoped to (team, email, role): accepting
// requires the caller's session email to match `email`, so a leaked link can't seat a different account.
export const teamInvitesTable = pgTable(
  'team_invites',
  {
    // sha256(rawToken); the invite link carries the raw token, exactly like email_verification_tokens.
    id: text('id').primaryKey(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'cascade' }),
    // Lowercased in code before insert so the unique(team, email) key and the accept-time match are
    // case-insensitive — Alice@x.com and alice@x.com are one invitee, not two.
    email: text('email').notNull(),
    // The role the invitee gets on accept. Never 'owner' (the route rejects that); a team gains owners
    // only through promotion, never an invite. Stored as the same enum so a bad value can't be inserted.
    role: teamRoleEnum('role').notNull(),
    // Who sent it — cascade, so deleting that user clears their outstanding invites (unlike teams, an
    // invite has no reason to outlive its sender).
    invitedById: uuid('invited_by_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one live invite per (team, email): re-inviting is delete-then-insert, which also rotates the
    // token so the previous link stops working. The unique key is the DB's race-safe guarantee of that.
    uniqueIndex('team_invites_team_email_unique').on(t.teamId, t.email),
    // "Which invites are outstanding for this team?" — the admin's pending list — scans by team.
    index('team_invites_team_idx').on(t.teamId),
  ],
)

/*
 * Document ↔ team sharing (step 4 — M5) — the many-to-many join between documents and teams
 *
 *   documents ──1──<── document_teams >──many──1── teams   (a doc shared into many teams; a team holds many docs)
 *
 * A document always lives in its OWNER's private space; being shared into a team is ADDITIVE — a row here
 * grants the team's members the team's access level over the doc, and removing the row revokes exactly that,
 * never touching the owner's own access. Effective access for a user on a doc is resolved from these rows:
 * owner → full; else the MAX access level over the teams that contain both the user and the doc (see
 * documents/access.ts). A join table (not a team_id column on documents) is what lets one doc reach several
 * teams at once — the whole point of "share with the design team AND the reviewers".
 */
export const documentTeamsTable = pgTable(
  'document_teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documentsTable.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teamsTable.id, { onDelete: 'cascade' }),
    // Who shared it — a footnote, NOT the authorization to unshare (that's computed from doc ownership +
    // team role in access.ts). set null like teams.created_by_id: deleting the sharer must not silently
    // unshare the doc, so the assignment survives with added_by_id nulled.
    addedById: uuid('added_by_id').references(() => usersTable.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A doc is shared into a team at most once: re-assigning the same pair is not a second share. The DB is
    // the race-safe arbiter — a duplicate insert is a 23505 the data layer turns into a 409, not a
    // check-then-insert two requests race.
    uniqueIndex('document_teams_document_team_unique').on(t.documentId, t.teamId),
    // "Which documents does this team hold?" — the team page's document list — scans by team.
    index('document_teams_team_idx').on(t.teamId),
  ],
)

export type UserRow = typeof usersTable.$inferSelect
export type NewUserRow = typeof usersTable.$inferInsert
export type AccountRow = typeof accountsTable.$inferSelect
export type SessionRow = typeof sessionsTable.$inferSelect
export type WebauthnCredentialRow = typeof webauthnCredentialsTable.$inferSelect
export type RecoveryCodeRow = typeof recoveryCodesTable.$inferSelect
// DocumentRow, not Document: the DOM already owns `Document` on the client, and this type's twin
// crosses to web/. A distinct name keeps the two from ever colliding or auto-importing wrong.
export type DocumentRow = typeof documentsTable.$inferSelect
export type NewDocumentRow = typeof documentsTable.$inferInsert
export type DocumentUpdateRow = typeof documentUpdatesTable.$inferSelect
export type TeamRow = typeof teamsTable.$inferSelect
export type NewTeamRow = typeof teamsTable.$inferInsert
export type TeamMemberRow = typeof teamMembersTable.$inferSelect
export type NewTeamMemberRow = typeof teamMembersTable.$inferInsert
export type TeamInviteRow = typeof teamInvitesTable.$inferSelect
export type NewTeamInviteRow = typeof teamInvitesTable.$inferInsert
export type DocumentTeamRow = typeof documentTeamsTable.$inferSelect
export type NewDocumentTeamRow = typeof documentTeamsTable.$inferInsert
