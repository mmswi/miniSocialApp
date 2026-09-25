import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { normalizeEmail } from '../auth/password-auth.ts'
import {
  getAuthUser,
  loadUserOrThrow,
  parseOrThrow,
  requireAuthHook,
} from '../auth/route-helpers.ts'
import { TEAM_ROLES } from '../db/schema.ts'
import { getDocumentForOwner } from '../documents/documents.ts'
import { conflict, forbidden, notFound } from '../lib/errors.ts'
import {
  DOCUMENT_ASSIGN_RESULTS,
  assignDocumentToTeam,
  listTeamDocuments,
  unassignDocumentFromTeam,
} from './assignments.ts'
import { TEAM_ROLE_RANK, requireTeamRole } from './authz.ts'
import {
  acceptTeamInvite,
  createTeamInvite,
  listTeamInvites,
  revokeTeamInvite,
  sendTeamInviteEmail,
} from './invites.ts'
import {
  createTeam,
  getTeamForMember,
  getTeamNameById,
  listTeamMembers,
  listTeamsForUser,
} from './teams.ts'

const createTeamBody = z.object({
  name: z.string().trim().min(1).max(100),
})

const teamIdParams = z.object({
  teamId: z.string().uuid(),
})

// Every role except superadmin, which changes hands only by transfer.
const createInviteBody = z.object({
  email: z.string().email(),
  role: z.enum([TEAM_ROLES.admin, TEAM_ROLES.member, TEAM_ROLES.viewer]),
})

// The raw invite token, straight from the emailed link's query string. It's the capability, so it's opaque
// here — validated only as a non-empty string; invites.ts hashes it and decides valid/expired/mismatch.
const acceptInviteBody = z.object({
  token: z.string().min(1),
})

// The invite's id is its token hash (from the admin listing) — a string, not a uuid, since it's a sha256
// hex digest, not a generated row id.
const inviteIdParams = z.object({
  teamId: z.string().uuid(),
  inviteId: z.string().min(1),
})

// Sharing a document into a team: the body names the document, the URL names the team.
const assignDocumentBody = z.object({
  documentId: z.string().uuid(),
})

// Both ids are in the path for unshare — DELETE /teams/:teamId/documents/:documentId.
const teamDocumentParams = z.object({
  teamId: z.string().uuid(),
  documentId: z.string().uuid(),
})

// Registered under /teams. Same shape as documentRoutes: authentication is one onRequest hook for the
// whole plugin (not re-awaited per handler), so every route here is auth-gated by construction — a new
// route can't forget it. Each handler then scopes to the caller via their membership, never a bare id.
export const teamRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('onRequest', requireAuthHook)

  // The sidebar's list: the teams this user is a member of, each with their role.
  app.get('/', async (req) => {
    const { userId } = getAuthUser(req)
    const teams = await listTeamsForUser(userId)
    return { teams }
  })

  // Create a team; the caller becomes its superadmin (createTeam seats the membership atomically).
  app.post('/', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const input = parseOrThrow(createTeamBody, req.body)
    const team = await createTeam({ name: input.name, creatorId: userId })
    return reply.code(201).send({ team })
  })

  // One team, member-scoped. A non-member (or a bad id) gets 404, never a 403 — the membership join is
  // the authorization, so the endpoint never confirms a team exists to someone excluded from it.
  app.get('/:teamId', async (req) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    const membership = await getTeamForMember({ teamId, userId })
    if (membership === null) {
      throw notFound('team_not_found', 'Team not found.')
    }
    // Hand the client the team and, separately, the caller's own role in it (drives which controls the
    // TeamPage later shows). role is split out of the joined row so `team` is a clean TeamSummary.
    const { role, ...team } = membership
    return { team, role }
  })

  // Invite an email to the team, as admin, member or viewer. Admin+ only.
  app.post('/:teamId/invites', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    const input = parseOrThrow(createInviteBody, req.body)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.admin })
    // Name for the email body. The guard already proved the team exists and the caller may act on it, so a
    // null here is only a delete-mid-request race — reported as the same 404 a non-member would get.
    const teamName = await getTeamNameById(teamId)
    if (teamName === null) {
      throw notFound('team_not_found', 'Team not found.')
    }
    // One normalization point per request: lowercased so the unique(team, email) key and the accept-time
    // match are case-insensitive, and so we email the same address we stored.
    const email = normalizeEmail(input.email)
    const { rawToken, expiresAt } = await createTeamInvite({
      teamId,
      email,
      role: input.role,
      invitedById: userId,
    })
    await sendTeamInviteEmail({ to: email, teamName, rawToken })
    // The raw token is never returned — it lives only in the email. The client gets the pending-invite
    // summary it needs to render the row it just created; the token hash id comes back on the list read.
    return reply.code(201).send({ invite: { email, role: input.role, expiresAt } })
  })

  // The team's outstanding invites — the admin's pending list. Admin+ only; a plain member can't see who's
  // been invited.
  app.get('/:teamId/invites', async (req) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.admin })
    const invites = await listTeamInvites(teamId)
    return { invites }
  })

  // Revoke an outstanding invite by its id (the token hash from the listing). Admin+ only. teamId scopes the
  // delete, so revoking is confined to invites of a team the caller actually administers.
  app.delete('/:teamId/invites/:inviteId', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { teamId, inviteId } = parseOrThrow(inviteIdParams, req.params)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.admin })
    const revoked = await revokeTeamInvite({ teamId, inviteId })
    if (!revoked) {
      throw notFound('invite_not_found', 'Invite not found.')
    }
    return reply.code(204).send()
  })

  // Accept an invite: the caller redeems a raw token to join the team it names. Authed (this whole plugin
  // is), so we know who is accepting; their stored email must match the address the invite was sent to.
  // Note the path is static `/invites/accept`, a sibling of the parametric `/:teamId/...` routes — Fastify
  // matches the static segment first, so there's no clash with a team id that happened to read "invites".
  app.post('/invites/accept', async (req) => {
    const { userId } = getAuthUser(req)
    const input = parseOrThrow(acceptInviteBody, req.body)
    // The caller's own email (lowercased at signup) is the identity the invite is bound to — load it here
    // rather than trusting anything from the request body.
    const user = await loadUserOrThrow(userId)
    const team = await acceptTeamInvite({
      rawToken: input.token,
      userId,
      sessionEmail: user.email,
    })
    return { team }
  })

  // The team's members — the team page's member list. Member+ to see it (a non-member gets 404, no oracle).
  app.get('/:teamId/members', async (req) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.member })
    const members = await listTeamMembers(teamId)
    return { members }
  })

  // The documents shared into this team — the team page's document list. Member+ to see it (a non-member
  // gets 404, never a 403, so the endpoint isn't an existence oracle). Each item carries its owner's name.
  app.get('/:teamId/documents', async (req) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.member })
    const documents = await listTeamDocuments(teamId)
    return { documents }
  })

  // Share one of YOUR documents into the team. Two gates: member+ to reach the team (non-member → 404), and
  // the document must be one you OWN — a doc you don't own, or that doesn't exist, is 404, never a hint that
  // it exists. Sharing the same doc twice is a 409, and the unique(document, team) index is what decides it
  // (assignDocumentToTeam turns the 23505 into alreadyShared) — not a check-then-insert that could race.
  app.post('/:teamId/documents', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { teamId } = parseOrThrow(teamIdParams, req.params)
    const input = parseOrThrow(assignDocumentBody, req.body)
    await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.member })
    const document = await getDocumentForOwner({ documentId: input.documentId, ownerId: userId })
    if (document === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    const result = await assignDocumentToTeam({
      documentId: input.documentId,
      teamId,
      addedById: userId,
    })
    if (result === DOCUMENT_ASSIGN_RESULTS.alreadyShared) {
      throw conflict('document_already_shared', 'That document is already shared with this team.')
    }
    return reply.code(201).send({ document })
  })

  // Unshare a document from the team. Two ways to be allowed: you own the document, OR you're an admin+ of
  // the team. A caller who is neither the owner nor a member gets 404 (no oracle); a member or viewer who is
  // not the owner gets 403. A pair that wasn't shared is 404 once past the guard.
  app.delete('/:teamId/documents/:documentId', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { teamId, documentId } = parseOrThrow(teamDocumentParams, req.params)
    const membership = await getTeamForMember({ teamId, userId })
    const ownsDocument = (await getDocumentForOwner({ documentId, ownerId: userId })) !== null
    if (membership === null && !ownsDocument) {
      throw notFound('team_not_found', 'Team not found.')
    }
    const isTeamAdminPlus =
      membership !== null && TEAM_ROLE_RANK[membership.role] >= TEAM_ROLE_RANK[TEAM_ROLES.admin]
    const mayUnassign = ownsDocument || isTeamAdminPlus
    if (!mayUnassign) {
      throw forbidden('insufficient_team_role', 'You do not have permission to do that.')
    }
    const removed = await unassignDocumentFromTeam({ documentId, teamId })
    if (!removed) {
      throw notFound('document_share_not_found', 'That document is not shared with this team.')
    }
    return reply.code(204).send()
  })
}
