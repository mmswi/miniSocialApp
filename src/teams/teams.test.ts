import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { isUniqueViolation } from '../db/errors.ts'
import {
  TEAM_ACCESS_LEVELS,
  TEAM_ROLES,
  type TeamAccessLevel,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import { createTeam, getTeamForMember, listTeamsForUser } from './teams.ts'

// Integration tests against the dockerized Postgres. A creator (who becomes a team's first owner) and a
// stranger (in no team) so the membership scoping is real — a stranger must never reach a team's row.
const creatorEmail = `team-creator-${randomUUID()}@example.test`
const strangerEmail = `team-stranger-${randomUUID()}@example.test`
let creatorId = ''
let strangerId = ''

// Every team created here is recorded so afterAll can delete it. A team's created_by_id is set-null (not
// cascade), so deleting the users alone would leave orphan team rows behind — we clean teams explicitly.
const createdTeamIds: string[] = []
const isolatedUserIds: string[] = []

const makeTeam = async (input: {
  name: string
  accessLevel?: TeamAccessLevel
  creatorId: string
}): Promise<{ id: string; name: string; accessLevel: TeamAccessLevel }> => {
  const team = await createTeam({
    name: input.name,
    accessLevel: input.accessLevel,
    creatorId: input.creatorId,
  })
  createdTeamIds.push(team.id)
  return team
}

const seedIsolatedUser = async (): Promise<string> => {
  const [user] = await db
    .insert(usersTable)
    .values({ email: `team-iso-${randomUUID()}@example.test` })
    .returning()
  if (user === undefined) {
    throw new Error('failed to seed isolated user')
  }
  isolatedUserIds.push(user.id)
  return user.id
}

beforeAll(async () => {
  const seeded = await db
    .insert(usersTable)
    .values([{ email: creatorEmail }, { email: strangerEmail }])
    .returning()
  const creator = seeded.find((u) => u.email === creatorEmail)
  const stranger = seeded.find((u) => u.email === strangerEmail)
  if (creator === undefined || stranger === undefined) {
    throw new Error('failed to seed test users')
  }
  creatorId = creator.id
  strangerId = stranger.id
})

afterAll(async () => {
  // Teams first (cascades their memberships), then the users — including the isolated ones.
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds))
  }
  await db.delete(usersTable).where(inArray(usersTable.email, [creatorEmail, strangerEmail]))
  if (isolatedUserIds.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.id, isolatedUserIds))
  }
})

describe('teams data access', () => {
  test('a created team seats the creator as its superadmin and defaults to read access', async () => {
    const team = await makeTeam({ name: 'Design crew', creatorId })
    expect(team.name).toBe('Design crew')
    expect(team.accessLevel).toBe(TEAM_ACCESS_LEVELS.read)

    // The authorization that matters is the membership, not created_by_id.
    const membership = await getTeamForMember({ teamId: team.id, userId: creatorId })
    expect(membership?.role).toBe(TEAM_ROLES.superadmin)
  })

  test('the database refuses a second superadmin in the same team', async () => {
    const team = await makeTeam({ name: 'One at the top', creatorId })
    const secondSuperadminInsert = db
      .insert(teamMembersTable)
      .values({ teamId: team.id, userId: strangerId, role: TEAM_ROLES.superadmin })
    const insertError = await secondSuperadminInsert.then(
      () => null,
      (error: unknown) => error,
    )
    expect(isUniqueViolation(insertError)).toBe(true)

    // Other roles are not limited: the same user joins fine as an admin.
    await db
      .insert(teamMembersTable)
      .values({ teamId: team.id, userId: strangerId, role: TEAM_ROLES.admin })
    const strangerMembership = await getTeamForMember({ teamId: team.id, userId: strangerId })
    expect(strangerMembership?.role).toBe(TEAM_ROLES.admin)
  })

  test('an explicit access level is stored as given', async () => {
    const team = await makeTeam({
      name: 'Editors',
      accessLevel: TEAM_ACCESS_LEVELS.write,
      creatorId,
    })
    expect(team.accessLevel).toBe(TEAM_ACCESS_LEVELS.write)
  })

  test('getTeamForMember returns null for a non-member — never a team they can’t see', async () => {
    const team = await makeTeam({ name: 'Private', creatorId })
    expect(await getTeamForMember({ teamId: team.id, userId: strangerId })).toBeNull()
  })

  test('getTeamForMember returns null for an unknown id', async () => {
    expect(await getTeamForMember({ teamId: randomUUID(), userId: creatorId })).toBeNull()
  })

  test('the list returns only the caller’s teams, newest first, each with their role', async () => {
    // An isolated user so the ordering assertion isn't perturbed by teams other tests made.
    const isolatedId = await seedIsolatedUser()
    const first = await makeTeam({ name: 'first', creatorId: isolatedId })
    const second = await makeTeam({ name: 'second', creatorId: isolatedId })

    const listed = await listTeamsForUser(isolatedId)
    expect(listed.map((t) => t.id)).toEqual([second.id, first.id])
    expect(listed.every((t) => t.role === TEAM_ROLES.superadmin)).toBe(true)
  })

  test('a stranger’s list excludes a team they were never added to', async () => {
    const team = await makeTeam({ name: 'exclusive', creatorId })
    const strangerTeams = await listTeamsForUser(strangerId)
    expect(strangerTeams.map((t) => t.id)).not.toContain(team.id)
  })
})
