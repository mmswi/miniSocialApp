import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAuthUser, parseOrThrow, requireAuthHook } from '../auth/route-helpers.ts'
import { TEAM_ACCESS_LEVELS } from '../db/schema.ts'
import { notFound } from '../lib/errors.ts'
import { createTeam, getTeamForMember, listTeamsForUser } from './teams.ts'

const createTeamBody = z.object({
  name: z.string().trim().min(1).max(100),
  // Optional — omitting it lets the column default ('read', the safest ceiling) apply. Each option is a
  // named constant, not a bare 'read'/'write'/'delete', so the enum stays the single source of truth.
  accessLevel: z
    .enum([TEAM_ACCESS_LEVELS.read, TEAM_ACCESS_LEVELS.write, TEAM_ACCESS_LEVELS.delete])
    .optional(),
})

const teamIdParams = z.object({
  teamId: z.string().uuid(),
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

  // Create a team; the caller becomes its first owner (createTeam seats the membership atomically).
  app.post('/', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const input = parseOrThrow(createTeamBody, req.body)
    const team = await createTeam({
      name: input.name,
      accessLevel: input.accessLevel,
      creatorId: userId,
    })
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
}
