import { and, desc, eq } from 'drizzle-orm'
import { generateToken, hashToken } from '../auth/tokens.ts'
import { db } from '../db/client.ts'
import {
  type TeamRole,
  teamInvitesTable,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import { env } from '../lib/env.ts'
import { badRequest, conflict, forbidden } from '../lib/errors.ts'
import { enqueueEmail } from '../queue/email-queue.ts'

// 7 days: long enough to survive a weekend inbox, short enough that a leaked link ages out on its own.
// Longer than email verification's 24h because an invite is a deliberate hand-off between two people —
// the recipient may not be watching their inbox the moment it lands, where a self-serve signup is.
const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7

type IssuedInvite = { rawToken: string; expiresAt: Date }

// Is someone with this email ALREADY a member of the team? Then there's nothing to invite. The join IS the
// check: a users row for this (already-lowercased) email whose id also holds a membership in this team. The
// route turns a true here into a 409 rather than minting a dead invite the recipient could never act on.
const isEmailAlreadyMember = async (input: {
  teamId: string
  email: string
}): Promise<boolean> => {
  const [existing] = await db
    .select({ userId: teamMembersTable.userId })
    .from(teamMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, teamMembersTable.userId))
    .where(and(eq(teamMembersTable.teamId, input.teamId), eq(usersTable.email, input.email)))
    .limit(1)
  return existing !== undefined
}

// Issue a single-use invite for an email to join a team at a role. Mirrors createEmailVerificationToken:
// only sha256(rawToken) is stored (the id column), and the raw token rides in the emailed link — a DB leak
// yields no usable invite. Re-inviting the same email is delete-then-insert in one transaction, which
// rotates the token: the previous link stops working the instant a fresh one is sent. `email` must already
// be lowercased by the caller (the route normalizes it), so the unique(team, email) key is case-insensitive.
export const createTeamInvite = async (input: {
  teamId: string
  email: string
  role: TeamRole
  invitedById: string
}): Promise<IssuedInvite> => {
  if (await isEmailAlreadyMember({ teamId: input.teamId, email: input.email })) {
    throw conflict('already_member', 'That person is already a member of this team.')
  }
  const rawToken = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await db.transaction(async (tx) => {
    // Clear any outstanding invite for this (team, email) first, so the unique key can't reject the insert
    // and the old token is invalidated in the same breath. Re-invite always means a brand-new token.
    await tx
      .delete(teamInvitesTable)
      .where(
        and(eq(teamInvitesTable.teamId, input.teamId), eq(teamInvitesTable.email, input.email)),
      )
    await tx.insert(teamInvitesTable).values({
      id: hashToken(rawToken),
      teamId: input.teamId,
      email: input.email,
      role: input.role,
      invitedById: input.invitedById,
      expiresAt,
    })
  })
  return { rawToken, expiresAt }
}

// What the public preview endpoint shows the holder of a raw invite token: enough to render "Join <team>
// as <role>" and, when they're signed in as someone else, "this invite is for <email>". The URL's token is
// the only capability; this is what it unlocks. No id or hash is exposed — nothing here is a secret.
export type TeamInvitePreview = {
  teamId: string
  teamName: string
  email: string
  role: TeamRole
}

// The invite behind a raw token, joined to its team's name. Shared by preview (read-only) and accept
// (consume), so both resolve a token identically. Returns null on an unknown/used token; throws on expiry
// after deleting the dead row.
const findLiveInviteByToken = async (rawToken: string): Promise<TeamInvitePreview | null> => {
  const id = hashToken(rawToken)
  const [row] = await db
    .select({
      teamId: teamInvitesTable.teamId,
      teamName: teamsTable.name,
      email: teamInvitesTable.email,
      role: teamInvitesTable.role,
      expiresAt: teamInvitesTable.expiresAt,
    })
    .from(teamInvitesTable)
    .innerJoin(teamsTable, eq(teamsTable.id, teamInvitesTable.teamId))
    .where(eq(teamInvitesTable.id, id))
    .limit(1)
  // Unknown and already-consumed are indistinguishable: an accepted invite was deleted, so it has no row —
  // exactly like one that never existed. Neither is an oracle. The caller renders both as invalid_invite.
  if (row === undefined) {
    return null
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(teamInvitesTable).where(eq(teamInvitesTable.id, id))
    throw badRequest('invite_expired', 'This invite link has expired. Ask for a new one.')
  }
  return {
    teamId: row.teamId,
    teamName: row.teamName,
    email: row.email,
    role: row.role,
  }
}

// Resolve a raw token to its invite for the (public, no-auth) preview page. Same failure discipline as
// verifyEmailToken: expired is deleted and reported distinctly; unknown/used is an indistinguishable 400.
export const previewTeamInvite = async (rawToken: string): Promise<TeamInvitePreview> => {
  const invite = await findLiveInviteByToken(rawToken)
  if (invite === null) {
    throw badRequest('invalid_invite', 'This invite link is invalid or has already been used.')
  }
  return invite
}

// The result of accepting: which team the caller just joined, so the route can point them at it. No role —
// the team page refetches the caller's actual membership, which for an already-member accept may outrank
// the invite's role.
export type AcceptedInvite = { teamId: string; teamName: string }

// Consume an invite: seat the caller in the team and burn the token, atomically. Guards, in order:
//   • unknown / already-used token → 400 invalid_invite (no oracle, same answer as preview)
//   • expired                      → 400 invite_expired, and the dead row is deleted
//   • email mismatch               → 403, and the token is NOT consumed
// The email match binds the invite to the address it was mailed to: receiving the token already proves
// control of that inbox, so this only stops a DIFFERENT signed-in account (who got the link some other way)
// from silently joining. On mismatch the invite survives, so the intended recipient can still sign in as
// themselves and accept. Seating uses onConflictDoNothing on the (team, user) unique key, so accepting an
// invite when you're already a member is idempotent — no duplicate row, no role change, invite still cleared.
// `sessionEmail` is the caller's stored email, already lowercased at signup, so the compare is direct.
export const acceptTeamInvite = async (input: {
  rawToken: string
  userId: string
  sessionEmail: string
}): Promise<AcceptedInvite> => {
  const invite = await findLiveInviteByToken(input.rawToken)
  if (invite === null) {
    throw badRequest('invalid_invite', 'This invite link is invalid or has already been used.')
  }
  if (invite.email !== input.sessionEmail) {
    throw forbidden('invite_email_mismatch', 'This invite was sent to a different email address.')
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(teamMembersTable)
      .values({ teamId: invite.teamId, userId: input.userId, role: invite.role })
      .onConflictDoNothing({ target: [teamMembersTable.teamId, teamMembersTable.userId] })
    await tx.delete(teamInvitesTable).where(eq(teamInvitesTable.id, hashToken(input.rawToken)))
  })
  return { teamId: invite.teamId, teamName: invite.teamName }
}

// One outstanding invite as the admin's pending list sees it. `id` IS the token hash — safe to expose as a
// delete handle, because sha256 is one-way: it can't be turned back into the raw token needed to accept.
export type TeamInviteSummary = {
  id: string
  email: string
  role: TeamRole
  expiresAt: Date
  createdAt: Date
}

// The invites still outstanding for a team, newest first — the admin's pending list. Team-scoped by the
// caller (the route guards membership); this read just filters to the one team.
export const listTeamInvites = async (teamId: string): Promise<TeamInviteSummary[]> => {
  return db
    .select({
      id: teamInvitesTable.id,
      email: teamInvitesTable.email,
      role: teamInvitesTable.role,
      expiresAt: teamInvitesTable.expiresAt,
      createdAt: teamInvitesTable.createdAt,
    })
    .from(teamInvitesTable)
    .where(eq(teamInvitesTable.teamId, teamId))
    .orderBy(desc(teamInvitesTable.createdAt))
}

// Revoke an outstanding invite by its id (the hash from the listing). Scoped by teamId as well, so an admin
// of one team can't delete another team's invite by guessing its id. Returns whether a row was actually
// removed — the route answers 204 if so, 404 if the id matched nothing in this team.
export const revokeTeamInvite = async (input: {
  teamId: string
  inviteId: string
}): Promise<boolean> => {
  const deleted = await db
    .delete(teamInvitesTable)
    .where(and(eq(teamInvitesTable.id, input.inviteId), eq(teamInvitesTable.teamId, input.teamId)))
    .returning({ id: teamInvitesTable.id })
  return deleted.length > 0
}

// The link we email. Points at the frontend invite landing page (/invite); the raw token rides in the
// query string, since only its hash is stored. That page previews the invite, then accepts — bouncing
// through login first if the recipient isn't signed in yet.
// NOTE: the `inviteToken` param name is duplicated in the frontend (web/src/lib/invite-link.ts,
// INVITE_TOKEN_PARAM). They can't share a constant across the src/ ↔ web/ boundary, so a rename here must
// be mirrored there by hand — the whole accept flow reads this exact param off the URL.
const inviteLink = (rawToken: string): string => `${env.APP_URL}/invite?inviteToken=${rawToken}`

// Render the invitation and hand it to the durable email queue — the worker does the SMTP send with
// retries, so a flaky provider can't lose the link. Under `bun test` it delivers inline into `sentEmails`,
// the same in-memory contract the auth E2E reads its tokens out of.
export const sendTeamInviteEmail = async (input: {
  to: string
  teamName: string
  rawToken: string
}): Promise<void> => {
  await enqueueEmail({
    to: input.to,
    subject: `You've been invited to join ${input.teamName} on redline`,
    text: `You've been invited to join the team "${input.teamName}" on redline.\n\nAccept the invitation by opening this link:\n\n${inviteLink(input.rawToken)}\n\nThis invite expires in 7 days. If you weren't expecting it, you can ignore this email — nothing was created for you.`,
  })
}
