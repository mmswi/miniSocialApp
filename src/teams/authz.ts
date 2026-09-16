import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ACCESS_LEVELS,
  TEAM_ROLES,
  type TeamAccessLevel,
  type TeamRole,
  teamMembersTable,
} from '../db/schema.ts'
import { forbidden, notFound } from '../lib/errors.ts'

// Team roles are ordered: owner ⊃ admin ⊃ member. A guard asks "at least this rank?", so each role needs
// a comparable number. This rank map is deliberately in TS, NOT SQL `max()` over the pg enum: an enum's
// implicit numeric value is its declaration order, which would silently couple "who outranks whom" to the
// order the enum happens to list its members. Rank is a domain rule — it belongs in code, where it reads.
// Typed as Record<TeamRole, number> so adding a role without ranking it is a compile error, not a 0.
export const TEAM_ROLE_RANK: Record<TeamRole, number> = {
  [TEAM_ROLES.member]: 1,
  [TEAM_ROLES.admin]: 2,
  [TEAM_ROLES.owner]: 3,
}

// The access-level chain read ⊂ write ⊂ delete, ranked for the same reason and the same way as roles: rank
// is a domain rule kept in TS, not the pg enum's declaration order. The effective-access resolver
// (documents/access.ts) uses it to pick the MAX level over the teams a user reaches a document through.
export const TEAM_ACCESS_LEVEL_RANK: Record<TeamAccessLevel, number> = {
  [TEAM_ACCESS_LEVELS.read]: 1,
  [TEAM_ACCESS_LEVELS.write]: 2,
  [TEAM_ACCESS_LEVELS.delete]: 3,
}

// The caller's role in a team, or null when they aren't a member. null is the "you may not see this team"
// answer: a route turns it into a 404, never a 403, so the endpoint is not an existence oracle — a
// non-member can't tell a team they're excluded from apart from one that doesn't exist.
export const getTeamRole = async (input: {
  teamId: string
  userId: string
}): Promise<TeamRole | null> => {
  const [membership] = await db
    .select({ role: teamMembersTable.role })
    .from(teamMembersTable)
    .where(
      and(eq(teamMembersTable.teamId, input.teamId), eq(teamMembersTable.userId, input.userId)),
    )
    .limit(1)
  return membership === undefined ? null : membership.role
}

// The authorization seam every team mutation reuses: resolve the caller's role and hold it to a floor.
// Two failure modes, two status codes, on purpose:
//   • not a member (null)          → 404, indistinguishable from a team that doesn't exist (no oracle)
//   • a member but under the floor → 403, because they already know the team exists — they're in it
// Returns the actual role on success (guaranteed ≥ atLeast) so a caller that needs the role skips a
// second query. The three slice routes don't guard on rank yet; the member-management pass is its first
// consumer. It's built and tested now because the null→404 / under-rank→403 split is milestone 2's point.
export const requireTeamRole = async (input: {
  teamId: string
  userId: string
  atLeast: TeamRole
}): Promise<TeamRole> => {
  const role = await getTeamRole({ teamId: input.teamId, userId: input.userId })
  if (role === null) {
    throw notFound('team_not_found', 'Team not found.')
  }
  const meetsFloor = TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK[input.atLeast]
  if (!meetsFloor) {
    throw forbidden('insufficient_team_role', 'You do not have permission to do that.')
  }
  return role
}
