import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ACCESS_LEVELS,
  TEAM_ROLES,
  type TeamAccessLevel,
  documentTeamsTable,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import { DOCUMENT_ACCESS_OWNER, getDocumentAccessForUser } from './access.ts'
import { createDocument } from './documents.ts'

// Direct-to-Postgres tests of the effective-access resolver. We seed the whole graph by hand — users, a
// document, teams at different levels, memberships, shares — because the resolver's job is to fold all of
// that into a single answer, and only a real graph exercises the max-over-teams and owner-beats-teams paths.
const emails: string[] = []
const teamIds: string[] = []

const seedUser = async (prefix: string): Promise<string> => {
  const email = `${prefix}-${randomUUID()}@example.test`
  emails.push(email)
  const [user] = await db.insert(usersTable).values({ email }).returning({ id: usersTable.id })
  if (user === undefined) {
    throw new Error('failed to seed user')
  }
  return user.id
}

const seedTeam = async (accessLevel: TeamAccessLevel): Promise<string> => {
  const [team] = await db
    .insert(teamsTable)
    .values({ name: `team-${randomUUID()}`, accessLevel })
    .returning({ id: teamsTable.id })
  if (team === undefined) {
    throw new Error('failed to seed team')
  }
  teamIds.push(team.id)
  return team.id
}

const seatMember = (teamId: string, userId: string): Promise<unknown> =>
  db.insert(teamMembersTable).values({ teamId, userId, role: TEAM_ROLES.member })

const shareInto = (documentId: string, teamId: string): Promise<unknown> =>
  db.insert(documentTeamsTable).values({ documentId, teamId })

afterAll(async () => {
  if (teamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, teamIds))
  }
  if (emails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, emails))
  }
})

describe('getDocumentAccessForUser', () => {
  test('the owner gets full access', async () => {
    const ownerId = await seedUser('res-owner')
    const doc = await createDocument({ ownerId })
    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId: ownerId })
    expect(resolved?.access).toBe(DOCUMENT_ACCESS_OWNER)
    expect(resolved?.document.id).toBe(doc.id)
  })

  test("a member of a team the doc is shared into gets that team's level", async () => {
    const ownerId = await seedUser('res-owner-shared')
    const memberId = await seedUser('res-member')
    const doc = await createDocument({ ownerId })
    const teamId = await seedTeam(TEAM_ACCESS_LEVELS.write)
    await seatMember(teamId, memberId)
    await shareInto(doc.id, teamId)

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId: memberId })
    expect(resolved?.access).toBe(TEAM_ACCESS_LEVELS.write)
  })

  test('shared into several of the user’s teams → the MAX level wins', async () => {
    const ownerId = await seedUser('res-owner-max')
    const userId = await seedUser('res-multi')
    const doc = await createDocument({ ownerId })
    const readTeam = await seedTeam(TEAM_ACCESS_LEVELS.read)
    const deleteTeam = await seedTeam(TEAM_ACCESS_LEVELS.delete)
    const writeTeam = await seedTeam(TEAM_ACCESS_LEVELS.write)
    for (const teamId of [readTeam, deleteTeam, writeTeam]) {
      await seatMember(teamId, userId)
      await shareInto(doc.id, teamId)
    }

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId })
    expect(resolved?.access).toBe(TEAM_ACCESS_LEVELS.delete) // delete > write > read
  })

  test('a higher level from a team the user is NOT in does not count', async () => {
    const ownerId = await seedUser('res-owner-foreign')
    const userId = await seedUser('res-partial')
    const doc = await createDocument({ ownerId })
    const usersReadTeam = await seedTeam(TEAM_ACCESS_LEVELS.read)
    const foreignDeleteTeam = await seedTeam(TEAM_ACCESS_LEVELS.delete)
    await seatMember(usersReadTeam, userId)
    await shareInto(doc.id, usersReadTeam)
    await shareInto(doc.id, foreignDeleteTeam) // shared, but the user is not a member of this team

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId })
    expect(resolved?.access).toBe(TEAM_ACCESS_LEVELS.read) // NOT delete — the foreign team grants nothing
  })

  test('the owner keeps full access even when also a lower-level team member', async () => {
    const ownerId = await seedUser('res-owner-also-member')
    const doc = await createDocument({ ownerId })
    const readTeam = await seedTeam(TEAM_ACCESS_LEVELS.read)
    await seatMember(readTeam, ownerId)
    await shareInto(doc.id, readTeam)

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId: ownerId })
    expect(resolved?.access).toBe(DOCUMENT_ACCESS_OWNER)
  })

  test('a member of a team the doc is NOT shared into has no access', async () => {
    const ownerId = await seedUser('res-owner-outsider')
    const outsiderId = await seedUser('res-outsider')
    const doc = await createDocument({ ownerId })
    const teamId = await seedTeam(TEAM_ACCESS_LEVELS.write)
    await seatMember(teamId, outsiderId) // in a team, but the doc was never shared into it

    expect(await getDocumentAccessForUser({ documentId: doc.id, userId: outsiderId })).toBeNull()
  })

  test('a stranger with neither ownership nor a shared team gets null', async () => {
    const ownerId = await seedUser('res-owner-stranger')
    const strangerId = await seedUser('res-stranger')
    const doc = await createDocument({ ownerId })
    expect(await getDocumentAccessForUser({ documentId: doc.id, userId: strangerId })).toBeNull()
  })

  test('an unknown document id is null', async () => {
    const userId = await seedUser('res-unknown')
    expect(await getDocumentAccessForUser({ documentId: randomUUID(), userId })).toBeNull()
  })
})
