import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ROLES,
  type TeamAccessLevel,
  type TeamRole,
  type TeamRow,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'

// What a client needs to render a team — never the created_by_id footnote. Dates leave here as Date
// objects; the JSON layer renders them ISO on the wire (same convention as DocumentSummary).
export type TeamSummary = {
  id: string
  name: string
  accessLevel: TeamAccessLevel
  createdAt: Date
  updatedAt: Date
}

// A team as seen by one of its members: the summary plus THAT caller's role in it. The list and single-
// team reads both return this — role travels with the team so the client never has to ask "and what am I
// here?" separately. Named distinctly from TeamMemberRow (a raw team_members row) so the two never blur.
export type TeamWithRole = TeamSummary & { role: TeamRole }

const toTeamSummary = (row: TeamRow): TeamSummary => ({
  id: row.id,
  name: row.name,
  accessLevel: row.accessLevel,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// Create a team and, in the SAME transaction, seat the creator as its first owner. The two inserts are
// atomic on purpose: a team must never exist without an owner-role member, or it would be un-manageable
// and un-deletable (every team route authorizes off memberships, not created_by_id). Passing
// accessLevel: undefined omits the column so the DB default ('read', the safest ceiling) applies.
export const createTeam = async (input: {
  name: string
  accessLevel: TeamAccessLevel | undefined
  creatorId: string
}): Promise<TeamSummary> => {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teamsTable)
      .values({ name: input.name, accessLevel: input.accessLevel, createdById: input.creatorId })
      .returning()
    if (team === undefined) {
      throw new Error('team insert returned no row')
    }
    await tx
      .insert(teamMembersTable)
      .values({ teamId: team.id, userId: input.creatorId, role: TEAM_ROLES.owner })
    return toTeamSummary(team)
  })
}

// The teams a user belongs to, most-recently-touched first — the sidebar's list. The membership join IS
// the scoping: only teams with a row for this user come back, and each carries that user's role.
export const listTeamsForUser = async (userId: string): Promise<TeamWithRole[]> => {
  return db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      accessLevel: teamsTable.accessLevel,
      createdAt: teamsTable.createdAt,
      updatedAt: teamsTable.updatedAt,
      role: teamMembersTable.role,
    })
    .from(teamMembersTable)
    .innerJoin(teamsTable, eq(teamMembersTable.teamId, teamsTable.id))
    .where(eq(teamMembersTable.userId, userId))
    .orderBy(desc(teamsTable.updatedAt))
}

// One team, scoped to a member. The inner join to team_members on (team, THIS user) is the authorization,
// exactly like getDocumentForOwner's WHERE: a non-member — or a bad id — matches no row and returns null,
// which the route answers as 404 (never a 403 that would confirm the team exists). One round trip, so
// there's no window between "check membership" and "read the team" for the two to disagree.
export const getTeamForMember = async (input: {
  teamId: string
  userId: string
}): Promise<TeamWithRole | null> => {
  const [row] = await db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      accessLevel: teamsTable.accessLevel,
      createdAt: teamsTable.createdAt,
      updatedAt: teamsTable.updatedAt,
      role: teamMembersTable.role,
    })
    .from(teamsTable)
    .innerJoin(
      teamMembersTable,
      and(eq(teamMembersTable.teamId, teamsTable.id), eq(teamMembersTable.userId, input.userId)),
    )
    .where(eq(teamsTable.id, input.teamId))
    .limit(1)
  return row === undefined ? null : row
}

// A member of a team, as the team page's member list shows them: who they are + their role in the team.
// name is nullable (a user who never set one); the client falls back to the email. email is shown because
// team members collaborate — the same address book the invite flow already works in.
export type TeamMemberSummary = {
  userId: string
  name: string | null
  email: string
  role: TeamRole
}

// The members of a team, oldest-membership first (owners created the team, so they naturally lead). Scoping
// is the route's job (member+): this trusts it's being called for a team the caller may see.
export const listTeamMembers = async (teamId: string): Promise<TeamMemberSummary[]> => {
  return db
    .select({
      userId: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: teamMembersTable.role,
    })
    .from(teamMembersTable)
    .innerJoin(usersTable, eq(usersTable.id, teamMembersTable.userId))
    .where(eq(teamMembersTable.teamId, teamId))
    .orderBy(asc(teamMembersTable.createdAt))
}

// Just a team's name, by id — no membership scoping. The invite route calls this AFTER requireTeamRole has
// already proven the caller may act on this team, purely to fill in the email's subject/body; it is not an
// authorization check. Null only if the team was deleted between the guard and this read, which the route
// answers as a 404.
export const getTeamNameById = async (teamId: string): Promise<string | null> => {
  const [row] = await db
    .select({ name: teamsTable.name })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1)
  return row === undefined ? null : row.name
}
