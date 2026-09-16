import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { TEAM_ROLES, teamMembersTable, teamsTable, usersTable } from '../db/schema.ts'
import { AppError } from '../lib/errors.ts'
import { TEAM_ROLE_RANK, getTeamRole, requireTeamRole } from './authz.ts'
import { createTeam } from './teams.ts'

// An owner (the team's creator) and a stranger we selectively add as a plain member to exercise the
// under-rank path. Real Postgres, throwaway rows, cleaned up afterward.
const ownerEmail = `authz-owner-${randomUUID()}@example.test`
const strangerEmail = `authz-stranger-${randomUUID()}@example.test`
let ownerId = ''
let strangerId = ''
const createdTeamIds: string[] = []

const makeTeam = async (creatorId: string): Promise<string> => {
  const team = await createTeam({ name: 'authz team', accessLevel: undefined, creatorId })
  createdTeamIds.push(team.id)
  return team.id
}

// Run a call that should reject, and hand back the AppError it threw — so a test can assert on the exact
// statusCode and code, not just that "something threw".
const captureAppError = async (run: () => Promise<unknown>): Promise<AppError> => {
  try {
    await run()
  } catch (error) {
    if (error instanceof AppError) {
      return error
    }
    throw error
  }
  throw new Error('expected an AppError to be thrown')
}

beforeAll(async () => {
  const seeded = await db
    .insert(usersTable)
    .values([{ email: ownerEmail }, { email: strangerEmail }])
    .returning()
  const owner = seeded.find((u) => u.email === ownerEmail)
  const stranger = seeded.find((u) => u.email === strangerEmail)
  if (owner === undefined || stranger === undefined) {
    throw new Error('failed to seed test users')
  }
  ownerId = owner.id
  strangerId = stranger.id
})

afterAll(async () => {
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds))
  }
  await db.delete(usersTable).where(inArray(usersTable.email, [ownerEmail, strangerEmail]))
})

describe('team authz', () => {
  test('the role rank orders owner over admin over member', () => {
    expect(TEAM_ROLE_RANK[TEAM_ROLES.owner]).toBeGreaterThan(TEAM_ROLE_RANK[TEAM_ROLES.admin])
    expect(TEAM_ROLE_RANK[TEAM_ROLES.admin]).toBeGreaterThan(TEAM_ROLE_RANK[TEAM_ROLES.member])
  })

  test('getTeamRole returns the creator’s owner role and null for a non-member', async () => {
    const teamId = await makeTeam(ownerId)
    expect(await getTeamRole({ teamId, userId: ownerId })).toBe(TEAM_ROLES.owner)
    expect(await getTeamRole({ teamId, userId: strangerId })).toBeNull()
  })

  test('requireTeamRole returns the caller’s role when they meet the floor', async () => {
    const teamId = await makeTeam(ownerId)
    const role = await requireTeamRole({ teamId, userId: ownerId, atLeast: TEAM_ROLES.member })
    expect(role).toBe(TEAM_ROLES.owner)
  })

  test('requireTeamRole answers a non-member with 404, not 403 — no existence oracle', async () => {
    const teamId = await makeTeam(ownerId)
    const error = await captureAppError(() =>
      requireTeamRole({ teamId, userId: strangerId, atLeast: TEAM_ROLES.member }),
    )
    expect(error.statusCode).toBe(404)
    expect(error.code).toBe('team_not_found')
  })

  test('requireTeamRole answers an under-rank member with 403, and the team stays visible', async () => {
    const teamId = await makeTeam(ownerId)
    // The stranger is a plain member — they can see the team, but not act as an owner.
    await db
      .insert(teamMembersTable)
      .values({ teamId, userId: strangerId, role: TEAM_ROLES.member })

    const error = await captureAppError(() =>
      requireTeamRole({ teamId, userId: strangerId, atLeast: TEAM_ROLES.owner }),
    )
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe('insufficient_team_role')

    // 403 not 404: a member IS allowed to know the team exists — getTeamRole still sees them.
    expect(await getTeamRole({ teamId, userId: strangerId })).toBe(TEAM_ROLES.member)
  })
})
