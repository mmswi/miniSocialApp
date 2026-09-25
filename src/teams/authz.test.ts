import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { TEAM_ROLES, teamMembersTable, teamsTable, usersTable } from '../db/schema.ts'
import { AppError } from '../lib/errors.ts'
import { TEAM_ROLE_RANK, getTeamRole, requireTeamRole } from './authz.ts'
import { createTeam } from './teams.ts'

// The superadmin (the team's creator) and a stranger we selectively add as a plain member to exercise the
// under-rank path. Real Postgres, throwaway rows, cleaned up afterward.
const superadminEmail = `authz-superadmin-${randomUUID()}@example.test`
const strangerEmail = `authz-stranger-${randomUUID()}@example.test`
let superadminId = ''
let strangerId = ''
const createdTeamIds: string[] = []

const makeTeam = async (creatorId: string): Promise<string> => {
  const team = await createTeam({ name: 'authz team', creatorId })
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
    .values([{ email: superadminEmail }, { email: strangerEmail }])
    .returning()
  const superadmin = seeded.find((u) => u.email === superadminEmail)
  const stranger = seeded.find((u) => u.email === strangerEmail)
  if (superadmin === undefined || stranger === undefined) {
    throw new Error('failed to seed test users')
  }
  superadminId = superadmin.id
  strangerId = stranger.id
})

afterAll(async () => {
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds))
  }
  await db.delete(usersTable).where(inArray(usersTable.email, [superadminEmail, strangerEmail]))
})

describe('team authz', () => {
  test('the role rank orders superadmin over admin over member over viewer', () => {
    expect(TEAM_ROLE_RANK[TEAM_ROLES.superadmin]).toBeGreaterThan(TEAM_ROLE_RANK[TEAM_ROLES.admin])
    expect(TEAM_ROLE_RANK[TEAM_ROLES.admin]).toBeGreaterThan(TEAM_ROLE_RANK[TEAM_ROLES.member])
    expect(TEAM_ROLE_RANK[TEAM_ROLES.member]).toBeGreaterThan(TEAM_ROLE_RANK[TEAM_ROLES.viewer])
  })

  test('getTeamRole returns the creator’s superadmin role and null for a non-member', async () => {
    const teamId = await makeTeam(superadminId)
    expect(await getTeamRole({ teamId, userId: superadminId })).toBe(TEAM_ROLES.superadmin)
    expect(await getTeamRole({ teamId, userId: strangerId })).toBeNull()
  })

  test('requireTeamRole returns the caller’s role when they meet the floor', async () => {
    const teamId = await makeTeam(superadminId)
    const role = await requireTeamRole({ teamId, userId: superadminId, atLeast: TEAM_ROLES.member })
    expect(role).toBe(TEAM_ROLES.superadmin)
  })

  test('requireTeamRole answers a non-member with 404, not 403 — no existence oracle', async () => {
    const teamId = await makeTeam(superadminId)
    const error = await captureAppError(() =>
      requireTeamRole({ teamId, userId: strangerId, atLeast: TEAM_ROLES.member }),
    )
    expect(error.statusCode).toBe(404)
    expect(error.code).toBe('team_not_found')
  })

  test('requireTeamRole answers an under-rank member with 403, and the team stays visible', async () => {
    const teamId = await makeTeam(superadminId)
    // The stranger is a plain member — they can see the team, but not act as the superadmin.
    await db
      .insert(teamMembersTable)
      .values({ teamId, userId: strangerId, role: TEAM_ROLES.member })

    const error = await captureAppError(() =>
      requireTeamRole({ teamId, userId: strangerId, atLeast: TEAM_ROLES.superadmin }),
    )
    expect(error.statusCode).toBe(403)
    expect(error.code).toBe('insufficient_team_role')

    // 403 not 404: a member IS allowed to know the team exists — getTeamRole still sees them.
    expect(await getTeamRole({ teamId, userId: strangerId })).toBe(TEAM_ROLES.member)
  })
})
