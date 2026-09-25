import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ROLES,
  type TeamRole,
  documentTeamsTable,
  teamMembersTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import {
  DOCUMENT_ACCESS_LEVELS,
  DOCUMENT_ACCESS_OWNER,
  type DocumentAccessLevel,
  getDocumentAccessForUser,
} from './access.ts'
import { createDocument } from './documents.ts'

// Direct-to-Postgres tests of the effective-access resolver. We seed the whole graph by hand — users, a
// document, teams, memberships at different roles, shares — because the resolver's job is to fold all of
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

const seedTeam = async (): Promise<string> => {
  const [team] = await db
    .insert(teamsTable)
    .values({ name: `team-${randomUUID()}` })
    .returning({ id: teamsTable.id })
  if (team === undefined) {
    throw new Error('failed to seed team')
  }
  teamIds.push(team.id)
  return team.id
}

const seatMember = (teamId: string, userId: string, role: TeamRole): Promise<unknown> =>
  db.insert(teamMembersTable).values({ teamId, userId, role })

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

  const levelByRole: [TeamRole, DocumentAccessLevel][] = [
    [TEAM_ROLES.viewer, DOCUMENT_ACCESS_LEVELS.read],
    [TEAM_ROLES.member, DOCUMENT_ACCESS_LEVELS.write],
    [TEAM_ROLES.admin, DOCUMENT_ACCESS_LEVELS.delete],
    [TEAM_ROLES.superadmin, DOCUMENT_ACCESS_LEVELS.delete],
  ]
  for (const [role, expectedLevel] of levelByRole) {
    test(`a ${role} of a team the doc is shared into gets ${expectedLevel}`, async () => {
      const ownerId = await seedUser(`res-owner-${role}`)
      const teammateId = await seedUser(`res-${role}`)
      const doc = await createDocument({ ownerId })
      const teamId = await seedTeam()
      await seatMember(teamId, teammateId, role)
      await shareInto(doc.id, teamId)

      const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId: teammateId })
      expect(resolved?.access).toBe(expectedLevel)
    })
  }

  test('shared into several of the user’s teams → the highest level wins', async () => {
    const ownerId = await seedUser('res-owner-max')
    const userId = await seedUser('res-multi')
    const doc = await createDocument({ ownerId })
    const viewerTeam = await seedTeam()
    const adminTeam = await seedTeam()
    const memberTeam = await seedTeam()
    await seatMember(viewerTeam, userId, TEAM_ROLES.viewer)
    await seatMember(adminTeam, userId, TEAM_ROLES.admin)
    await seatMember(memberTeam, userId, TEAM_ROLES.member)
    for (const teamId of [viewerTeam, adminTeam, memberTeam]) {
      await shareInto(doc.id, teamId)
    }

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId })
    expect(resolved?.access).toBe(DOCUMENT_ACCESS_LEVELS.delete) // admin (delete) > member > viewer
  })

  test('a higher role in a team the user is NOT in does not count', async () => {
    const ownerId = await seedUser('res-owner-foreign')
    const userId = await seedUser('res-partial')
    const foreignAdminId = await seedUser('res-foreign-admin')
    const doc = await createDocument({ ownerId })
    const usersTeam = await seedTeam()
    const foreignTeam = await seedTeam()
    await seatMember(usersTeam, userId, TEAM_ROLES.viewer)
    await seatMember(foreignTeam, foreignAdminId, TEAM_ROLES.admin)
    await shareInto(doc.id, usersTeam)
    await shareInto(doc.id, foreignTeam) // shared, but the user is not a member of this team

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId })
    expect(resolved?.access).toBe(DOCUMENT_ACCESS_LEVELS.read) // NOT delete — the foreign team grants nothing
  })

  test('the owner keeps full access even when also a viewer in a team the doc is shared into', async () => {
    const ownerId = await seedUser('res-owner-also-member')
    const doc = await createDocument({ ownerId })
    const teamId = await seedTeam()
    await seatMember(teamId, ownerId, TEAM_ROLES.viewer)
    await shareInto(doc.id, teamId)

    const resolved = await getDocumentAccessForUser({ documentId: doc.id, userId: ownerId })
    expect(resolved?.access).toBe(DOCUMENT_ACCESS_OWNER)
  })

  test('a member of a team the doc is NOT shared into has no access', async () => {
    const ownerId = await seedUser('res-owner-outsider')
    const outsiderId = await seedUser('res-outsider')
    const doc = await createDocument({ ownerId })
    const teamId = await seedTeam()
    await seatMember(teamId, outsiderId, TEAM_ROLES.member) // in a team, but the doc was never shared into it

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
