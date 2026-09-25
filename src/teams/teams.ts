import { and, asc, desc, eq } from 'drizzle-orm'
import { type Db, db } from '../db/client.ts'
import {
  TEAM_ROLES,
  type TeamRole,
  type TeamRow,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import { TEAM_ROLE_RANK } from './authz.ts'

// What a client needs to render a team — never the created_by_id footnote. Dates leave here as Date
// objects; the JSON layer renders them ISO on the wire (same convention as DocumentSummary).
export type TeamSummary = {
  id: string
  name: string
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
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// Create a team and, in the SAME transaction, seat the creator as its superadmin. The two inserts are
// atomic on purpose: a team must never exist without its superadmin, or it would be un-manageable and
// un-deletable (every team route authorizes off memberships, not created_by_id).
export const createTeam = async (input: {
  name: string
  creatorId: string
}): Promise<TeamSummary> => {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teamsTable)
      .values({ name: input.name, createdById: input.creatorId })
      .returning()
    if (team === undefined) {
      throw new Error('team insert returned no row')
    }
    await tx
      .insert(teamMembersTable)
      .values({ teamId: team.id, userId: input.creatorId, role: TEAM_ROLES.superadmin })
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

// Rename a team. Returns null when the team no longer exists, which the route answers as a 404.
export const renameTeam = async (input: {
  teamId: string
  name: string
}): Promise<TeamSummary | null> => {
  const [row] = await db
    .update(teamsTable)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(teamsTable.id, input.teamId))
    .returning()
  return row === undefined ? null : toTeamSummary(row)
}

// Delete a team. Its members, invites and document shares go with it (cascade); the documents stay with
// their owners. Returns whether a row was removed.
export const deleteTeam = async (teamId: string): Promise<boolean> => {
  const deletedTeamRows = await db
    .delete(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .returning({ id: teamsTable.id })
  return deletedTeamRows.length > 0
}

// ---------- Membership changes ----------

export const MEMBERSHIP_CHANGE_RESULTS = {
  done: 'done',
  teamNotFound: 'teamNotFound',
  notAllowed: 'notAllowed',
  targetNotFound: 'targetNotFound',
  superadminMustTransfer: 'superadminMustTransfer',
} as const
export type MembershipChangeResult =
  (typeof MEMBERSHIP_CHANGE_RESULTS)[keyof typeof MEMBERSHIP_CHANGE_RESULTS]

export type TeamTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

// Locks the team row until the transaction ends (COMMIT or ROLLBACK). Every function that changes a team's
// members calls this first, so those changes run one after the other and each sees the previous one's
// result. Returns false if the team doesn't exist.
export const lockTeamRow = async (tx: TeamTransaction, teamId: string): Promise<boolean> => {
  const [lockedTeam] = await tx
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .for('update')
    .limit(1)
  return lockedTeam !== undefined
}

// Locks the team row, then reads every member's role. Null if the team doesn't exist.
const lockTeamAndReadRoles = async (
  tx: TeamTransaction,
  teamId: string,
): Promise<Map<string, TeamRole> | null> => {
  const isTeamLocked = await lockTeamRow(tx, teamId)
  if (!isTeamLocked) {
    return null
  }
  const memberRows = await tx
    .select({ userId: teamMembersTable.userId, role: teamMembersTable.role })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.teamId, teamId))
  return new Map(memberRows.map((memberRow) => [memberRow.userId, memberRow.role]))
}

const setMemberRole = (
  tx: TeamTransaction,
  input: { teamId: string; userId: string; role: TeamRole },
): Promise<unknown> =>
  tx
    .update(teamMembersTable)
    .set({ role: input.role })
    .where(
      and(eq(teamMembersTable.teamId, input.teamId), eq(teamMembersTable.userId, input.userId)),
    )

const deleteMembership = (
  tx: TeamTransaction,
  input: { teamId: string; userId: string },
): Promise<unknown> =>
  tx
    .delete(teamMembersTable)
    .where(
      and(eq(teamMembersTable.teamId, input.teamId), eq(teamMembersTable.userId, input.userId)),
    )

// Admin+ sets another member's role to admin, member or viewer. The superadmin's role changes only by
// transfer, and only the superadmin makes or unmakes admins.
export const changeMemberRole = async (input: {
  teamId: string
  actorId: string
  targetUserId: string
  newRole: typeof TEAM_ROLES.admin | typeof TEAM_ROLES.member | typeof TEAM_ROLES.viewer
}): Promise<MembershipChangeResult> =>
  db.transaction(async (tx) => {
    const rolesByUserId = await lockTeamAndReadRoles(tx, input.teamId)
    const actorRole = rolesByUserId?.get(input.actorId)
    if (rolesByUserId === null || actorRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.teamNotFound
    }
    const isActorAdminOrHigher = TEAM_ROLE_RANK[actorRole] >= TEAM_ROLE_RANK[TEAM_ROLES.admin]
    if (!isActorAdminOrHigher) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    const targetRole = rolesByUserId.get(input.targetUserId)
    if (targetRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.targetNotFound
    }
    const isTargetSuperadmin = targetRole === TEAM_ROLES.superadmin
    const involvesAdminRole = targetRole === TEAM_ROLES.admin || input.newRole === TEAM_ROLES.admin
    const isActorSuperadmin = actorRole === TEAM_ROLES.superadmin
    const isChangeForbidden = isTargetSuperadmin || (involvesAdminRole && !isActorSuperadmin)
    if (isChangeForbidden) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    await setMemberRole(tx, {
      teamId: input.teamId,
      userId: input.targetUserId,
      role: input.newRole,
    })
    return MEMBERSHIP_CHANGE_RESULTS.done
  })

// Admin+ removes a member whose role is strictly below theirs. Nobody outranks the superadmin, so the
// superadmin is never removed.
export const removeMember = async (input: {
  teamId: string
  actorId: string
  targetUserId: string
}): Promise<MembershipChangeResult> =>
  db.transaction(async (tx) => {
    const rolesByUserId = await lockTeamAndReadRoles(tx, input.teamId)
    const actorRole = rolesByUserId?.get(input.actorId)
    if (rolesByUserId === null || actorRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.teamNotFound
    }
    const isActorAdminOrHigher = TEAM_ROLE_RANK[actorRole] >= TEAM_ROLE_RANK[TEAM_ROLES.admin]
    if (!isActorAdminOrHigher) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    const targetRole = rolesByUserId.get(input.targetUserId)
    if (targetRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.targetNotFound
    }
    const doesActorOutrankTarget = TEAM_ROLE_RANK[actorRole] > TEAM_ROLE_RANK[targetRole]
    if (!doesActorOutrankTarget) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    await deleteMembership(tx, { teamId: input.teamId, userId: input.targetUserId })
    return MEMBERSHIP_CHANGE_RESULTS.done
  })

// A member leaves the team. The superadmin must transfer the role first, or the team would have none.
export const leaveTeam = async (input: {
  teamId: string
  userId: string
}): Promise<MembershipChangeResult> =>
  db.transaction(async (tx) => {
    const rolesByUserId = await lockTeamAndReadRoles(tx, input.teamId)
    const leaverRole = rolesByUserId?.get(input.userId)
    if (leaverRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.teamNotFound
    }
    if (leaverRole === TEAM_ROLES.superadmin) {
      return MEMBERSHIP_CHANGE_RESULTS.superadminMustTransfer
    }
    await deleteMembership(tx, { teamId: input.teamId, userId: input.userId })
    return MEMBERSHIP_CHANGE_RESULTS.done
  })

// The superadmin hands the role to another member and becomes an admin. The old superadmin is demoted
// first: the one-superadmin index is checked on every row write, so promoting first would fail.
export const transferSuperadmin = async (input: {
  teamId: string
  actorId: string
  targetUserId: string
}): Promise<MembershipChangeResult> =>
  db.transaction(async (tx) => {
    const rolesByUserId = await lockTeamAndReadRoles(tx, input.teamId)
    const actorRole = rolesByUserId?.get(input.actorId)
    if (rolesByUserId === null || actorRole === undefined) {
      return MEMBERSHIP_CHANGE_RESULTS.teamNotFound
    }
    if (actorRole !== TEAM_ROLES.superadmin) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    const isTargetAMember = rolesByUserId.has(input.targetUserId)
    if (!isTargetAMember) {
      return MEMBERSHIP_CHANGE_RESULTS.targetNotFound
    }
    const isTransferToSelf = input.targetUserId === input.actorId
    if (isTransferToSelf) {
      return MEMBERSHIP_CHANGE_RESULTS.notAllowed
    }
    await setMemberRole(tx, { teamId: input.teamId, userId: input.actorId, role: TEAM_ROLES.admin })
    await setMemberRole(tx, {
      teamId: input.teamId,
      userId: input.targetUserId,
      role: TEAM_ROLES.superadmin,
    })
    return MEMBERSHIP_CHANGE_RESULTS.done
  })
