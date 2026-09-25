import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { db } from '../db/client.ts'
import { teamMembersTable, teamsTable, usersTable } from '../db/schema.ts'
import { buildServer } from '../server.ts'

// Integration tests against the real /teams routes through Fastify's in-process inject. A session is
// earned the way a real user does: sign up, then log in. Throwaway emails + teams, cleaned up afterward.
const app = buildServer()
const createdEmails: string[] = []
const createdTeamIds: string[] = []
const password = 'correct horse battery staple'

type InjectResponse = Awaited<ReturnType<typeof app.inject>>

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

const sessionTokenFrom = (response: InjectResponse): string | undefined =>
  response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value

const signInNewUser = async (prefix: string): Promise<string> => {
  const email = uniqueEmail(prefix)
  await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } })
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })
  const token = sessionTokenFrom(login)
  if (token === undefined) {
    throw new Error('expected a session cookie after login')
  }
  return token
}

const authCookie = (token: string): { cookie: string } => ({
  cookie: `${SESSION_COOKIE_NAME}=${token}`,
})

// Create a team over HTTP and record its id for cleanup; returns the created team payload.
const createTeamAs = async (
  token: string,
  body: { name: string },
): Promise<{ id: string; name: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/teams',
    headers: authCookie(token),
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  const { team } = response.json<{ team: { id: string; name: string } }>()
  createdTeamIds.push(team.id)
  return team
}

// Like signInNewUser, but also resolves the new user's id — needed when a test seats them in a team
// directly (a role the create-team flow can't produce).
const signInNewUserWithId = async (prefix: string): Promise<{ token: string; userId: string }> => {
  const email = uniqueEmail(prefix)
  await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } })
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  })
  const token = sessionTokenFrom(login)
  if (token === undefined) {
    throw new Error('expected a session cookie after login')
  }
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1)
  if (user === undefined) {
    throw new Error('expected the signed-up user to exist')
  }
  return { token, userId: user.id }
}

// Seat a user in a team at a given role directly — the create-team flow only ever mints superadmins, so the
// member/admin cases of the unassign matrix need this. Deleting the team (cleanup) cascades the row.
const addTeamMember = async (
  teamId: string,
  userId: string,
  role: 'viewer' | 'member' | 'admin',
): Promise<void> => {
  await db.insert(teamMembersTable).values({ teamId, userId, role })
}

// Create a document over HTTP; its owner is the caller. Cleaned up when the owner (a throwaway user) is
// deleted — documents.owner_id cascades — so there's no separate document id list to track.
const createDocumentAs = async (
  token: string,
  title?: string,
): Promise<{ id: string; title: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/documents',
    headers: authCookie(token),
    payload: title === undefined ? {} : { title },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ document: { id: string; title: string } }>().document
}

// Share a document into a team over HTTP, asserting it took. Returns the response so a caller can also
// check the 409 path without this helper's success assertion getting in the way.
const assignDocument = (
  token: string,
  teamId: string,
  documentId: string,
): Promise<InjectResponse> =>
  app.inject({
    method: 'POST',
    url: `/teams/${teamId}/documents`,
    headers: authCookie(token),
    payload: { documentId },
  })

afterAll(async () => {
  if (createdTeamIds.length > 0) {
    await db.delete(teamsTable).where(inArray(teamsTable.id, createdTeamIds))
  }
  if (createdEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
  }
  await app.close()
})

describe('/teams', () => {
  test('rejects an unauthenticated request with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/teams' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'POST', url: '/teams', payload: { name: 'x' } })).statusCode,
    ).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/teams/${randomUUID()}` })).statusCode).toBe(
      401,
    )
  })

  test('create → list → get round-trips for the creator, who is the superadmin', async () => {
    const token = await signInNewUser('team-superadmin')
    const created = await createTeamAs(token, { name: 'Launch team' })
    expect(created.name).toBe('Launch team')

    const listed = await app.inject({ method: 'GET', url: '/teams', headers: authCookie(token) })
    const { teams } = listed.json<{ teams: { id: string; role: string }[] }>()
    expect(teams.map((t) => t.id)).toContain(created.id)
    expect(teams.find((t) => t.id === created.id)?.role).toBe('superadmin')

    const fetched = await app.inject({
      method: 'GET',
      url: `/teams/${created.id}`,
      headers: authCookie(token),
    })
    expect(fetched.statusCode).toBe(200)
    const body = fetched.json<{ team: { name: string }; role: string }>()
    expect(body.team.name).toBe('Launch team')
    expect(body.role).toBe('superadmin')
  })

  test('a blank name is a 400', async () => {
    const token = await signInNewUser('team-blank')
    const response = await app.inject({
      method: 'POST',
      url: '/teams',
      headers: authCookie(token),
      payload: { name: '   ' },
    })
    expect(response.statusCode).toBe(400)
  })

  test("a non-member gets 404 for someone else's team — never 403, no existence oracle", async () => {
    const superadminToken = await signInNewUser('team-secret-superadmin')
    const created = await createTeamAs(superadminToken, { name: 'secret' })

    const strangerToken = await signInNewUser('team-stranger')
    const asStranger = await app.inject({
      method: 'GET',
      url: `/teams/${created.id}`,
      headers: authCookie(strangerToken),
    })
    expect(asStranger.statusCode).toBe(404)

    // And the stranger's team list never mentions it.
    const strangerList = await app.inject({
      method: 'GET',
      url: '/teams',
      headers: authCookie(strangerToken),
    })
    const { teams } = strangerList.json<{ teams: { id: string }[] }>()
    expect(teams.map((t) => t.id)).not.toContain(created.id)
  })

  test('a non-uuid team id is a 400, not a 404', async () => {
    const token = await signInNewUser('team-badid')
    const response = await app.inject({
      method: 'GET',
      url: '/teams/not-a-uuid',
      headers: authCookie(token),
    })
    expect(response.statusCode).toBe(400)
  })

  test('members list: a member sees the roster; a non-member gets 404', async () => {
    const superadminToken = await signInNewUser('members-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Roster' })
    const member = await signInNewUserWithId('members-member')
    await addTeamMember(team.id, member.userId, 'member')

    const listed = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/members`,
      headers: authCookie(superadminToken),
    })
    expect(listed.statusCode).toBe(200)
    const { members } = listed.json<{ members: { userId: string; role: string }[] }>()
    expect(members.map((m) => m.role).sort()).toEqual(['member', 'superadmin'])
    expect(members.some((m) => m.userId === member.userId)).toBe(true)

    const strangerToken = await signInNewUser('members-stranger')
    const asStranger = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/members`,
      headers: authCookie(strangerToken),
    })
    expect(asStranger.statusCode).toBe(404)
  })

  test('a viewer sees the member list and the document list, but cannot share into the team', async () => {
    const superadminToken = await signInNewUser('viewer-lists-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Viewers welcome' })
    const sharedDocument = await createDocumentAs(superadminToken, 'Visible to viewers')
    expect((await assignDocument(superadminToken, team.id, sharedDocument.id)).statusCode).toBe(201)
    const viewer = await signInNewUserWithId('viewer-lists-viewer')
    await addTeamMember(team.id, viewer.userId, 'viewer')

    const membersAsViewer = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/members`,
      headers: authCookie(viewer.token),
    })
    expect(membersAsViewer.statusCode).toBe(200)

    const documentsAsViewer = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/documents`,
      headers: authCookie(viewer.token),
    })
    expect(documentsAsViewer.statusCode).toBe(200)
    const { documents } = documentsAsViewer.json<{ documents: { id: string }[] }>()
    expect(documents.map((document) => document.id)).toContain(sharedDocument.id)

    const viewersOwnDocument = await createDocumentAs(viewer.token, 'Viewer draft')
    const shareAsViewer = await assignDocument(viewer.token, team.id, viewersOwnDocument.id)
    expect(shareAsViewer.statusCode).toBe(403)
  })
})

describe('/teams/:teamId — rename and delete', () => {
  const renameAs = (token: string, teamId: string, name: string) =>
    app.inject({
      method: 'PATCH',
      url: `/teams/${teamId}`,
      headers: authCookie(token),
      payload: { name },
    })

  const deleteAs = (token: string, teamId: string) =>
    app.inject({ method: 'DELETE', url: `/teams/${teamId}`, headers: authCookie(token) })

  test('an admin renames the team', async () => {
    const superadminToken = await signInNewUser('rename-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Old name' })
    const admin = await signInNewUserWithId('rename-admin')
    await addTeamMember(team.id, admin.userId, 'admin')

    const renamed = await renameAs(admin.token, team.id, 'New name')
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json<{ team: { name: string } }>().team.name).toBe('New name')
  })

  test('a member or a viewer cannot rename — 403', async () => {
    const superadminToken = await signInNewUser('rename-deny-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Keep me' })
    for (const role of ['member', 'viewer'] as const) {
      const teammate = await signInNewUserWithId(`rename-deny-${role}`)
      await addTeamMember(team.id, teammate.userId, role)
      expect((await renameAs(teammate.token, team.id, 'Hijacked')).statusCode).toBe(403)
    }
  })

  test('a blank name is a 400', async () => {
    const superadminToken = await signInNewUser('rename-blank')
    const team = await createTeamAs(superadminToken, { name: 'Named' })
    expect((await renameAs(superadminToken, team.id, '   ')).statusCode).toBe(400)
  })

  test('the superadmin deletes the team; afterwards it is a 404', async () => {
    const superadminToken = await signInNewUser('delete-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Short-lived' })

    expect((await deleteAs(superadminToken, team.id)).statusCode).toBe(204)
    const teamAfterDelete = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}`,
      headers: authCookie(superadminToken),
    })
    expect(teamAfterDelete.statusCode).toBe(404)
  })

  test('an admin cannot delete the team — 403', async () => {
    const superadminToken = await signInNewUser('delete-deny-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Stays' })
    const admin = await signInNewUserWithId('delete-deny-admin')
    await addTeamMember(team.id, admin.userId, 'admin')
    expect((await deleteAs(admin.token, team.id)).statusCode).toBe(403)
  })

  test('a non-member gets 404 for rename and delete', async () => {
    const superadminToken = await signInNewUser('manage-secret-superadmin')
    const team = await createTeamAs(superadminToken, { name: 'Secret' })
    const strangerToken = await signInNewUser('manage-stranger')
    expect((await renameAs(strangerToken, team.id, 'Mine now')).statusCode).toBe(404)
    expect((await deleteAs(strangerToken, team.id)).statusCode).toBe(404)
  })

  test('deleting a team keeps the documents that were shared into it', async () => {
    const superadminToken = await signInNewUser('delete-keeps-docs')
    const team = await createTeamAs(superadminToken, { name: 'Temporary' })
    const sharedDocument = await createDocumentAs(superadminToken, 'Outlives the team')
    expect((await assignDocument(superadminToken, team.id, sharedDocument.id)).statusCode).toBe(201)

    expect((await deleteAs(superadminToken, team.id)).statusCode).toBe(204)
    const documentAfterDelete = await app.inject({
      method: 'GET',
      url: `/documents/${sharedDocument.id}`,
      headers: authCookie(superadminToken),
    })
    expect(documentAfterDelete.statusCode).toBe(200)
  })
})

describe('/teams/:teamId/documents — sharing', () => {
  test('rejects unauthenticated requests with 401', async () => {
    const teamId = randomUUID()
    const documentId = randomUUID()
    expect(
      (await app.inject({ method: 'GET', url: `/teams/${teamId}/documents` })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/teams/${teamId}/documents`,
          payload: { documentId },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (await app.inject({ method: 'DELETE', url: `/teams/${teamId}/documents/${documentId}` }))
        .statusCode,
    ).toBe(401)
  })

  test('an owner shares their document, and the team lists it', async () => {
    const token = await signInNewUser('share-owner')
    const team = await createTeamAs(token, { name: 'Sharers' })
    const document = await createDocumentAs(token, 'Q3 Launch Plan')

    const assigned = await assignDocument(token, team.id, document.id)
    expect(assigned.statusCode).toBe(201)

    const listed = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/documents`,
      headers: authCookie(token),
    })
    expect(listed.statusCode).toBe(200)
    const { documents } = listed.json<{
      documents: { id: string; title: string; ownerName: string | null }[]
    }>()
    expect(documents.map((d) => d.id)).toContain(document.id)
    expect(documents.find((d) => d.id === document.id)?.title).toBe('Q3 Launch Plan')
  })

  test('sharing the same document twice is a 409', async () => {
    const token = await signInNewUser('share-dup')
    const team = await createTeamAs(token, { name: 'Dup team' })
    const document = await createDocumentAs(token)

    expect((await assignDocument(token, team.id, document.id)).statusCode).toBe(201)
    expect((await assignDocument(token, team.id, document.id)).statusCode).toBe(409)
  })

  test("sharing a document you don't own is a 404, not a hint it exists", async () => {
    const ownerToken = await signInNewUser('share-realowner')
    const otherDocument = await createDocumentAs(ownerToken, 'Not yours')

    const assignerToken = await signInNewUser('share-thief')
    const assignerTeam = await createTeamAs(assignerToken, { name: 'Thief team' })

    const response = await assignDocument(assignerToken, assignerTeam.id, otherDocument.id)
    expect(response.statusCode).toBe(404)
  })

  test('a non-member can neither list nor share into the team — 404', async () => {
    const ownerToken = await signInNewUser('share-teamowner')
    const team = await createTeamAs(ownerToken, { name: 'Private team' })

    const strangerToken = await signInNewUser('share-stranger')
    const strangerDoc = await createDocumentAs(strangerToken)

    const listed = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/documents`,
      headers: authCookie(strangerToken),
    })
    expect(listed.statusCode).toBe(404)

    const assigned = await assignDocument(strangerToken, team.id, strangerDoc.id)
    expect(assigned.statusCode).toBe(404)
  })

  test('the document owner can unshare, and the document itself survives', async () => {
    const token = await signInNewUser('unshare-owner')
    const team = await createTeamAs(token, { name: 'Owner unshares' })
    const document = await createDocumentAs(token)
    expect((await assignDocument(token, team.id, document.id)).statusCode).toBe(201)

    const unassigned = await app.inject({
      method: 'DELETE',
      url: `/teams/${team.id}/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(unassigned.statusCode).toBe(204)

    // Unshare removes the share, never the document.
    const doc = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(doc.statusCode).toBe(200)

    // The team no longer lists it.
    const listed = await app.inject({
      method: 'GET',
      url: `/teams/${team.id}/documents`,
      headers: authCookie(token),
    })
    const { documents } = listed.json<{ documents: { id: string }[] }>()
    expect(documents.map((d) => d.id)).not.toContain(document.id)
  })

  test('an admin can unshare a document they do not own', async () => {
    const ownerToken = await signInNewUser('unshare-docowner')
    const team = await createTeamAs(ownerToken, { name: 'Admin unshares' })
    const document = await createDocumentAs(ownerToken)
    expect((await assignDocument(ownerToken, team.id, document.id)).statusCode).toBe(201)

    const admin = await signInNewUserWithId('unshare-admin')
    await addTeamMember(team.id, admin.userId, 'admin')

    const unassigned = await app.inject({
      method: 'DELETE',
      url: `/teams/${team.id}/documents/${document.id}`,
      headers: authCookie(admin.token),
    })
    expect(unassigned.statusCode).toBe(204)
  })

  test('a member who does not own the document cannot unshare it — 403', async () => {
    const ownerToken = await signInNewUser('unshare-writeowner')
    const team = await createTeamAs(ownerToken, { name: 'Members team' })
    const document = await createDocumentAs(ownerToken)
    expect((await assignDocument(ownerToken, team.id, document.id)).statusCode).toBe(201)

    const member = await signInNewUserWithId('unshare-writemember')
    await addTeamMember(team.id, member.userId, 'member')

    const unassigned = await app.inject({
      method: 'DELETE',
      url: `/teams/${team.id}/documents/${document.id}`,
      headers: authCookie(member.token),
    })
    expect(unassigned.statusCode).toBe(403)
  })

  test('unsharing a pair that was never shared is a 404', async () => {
    const token = await signInNewUser('unshare-neverowner')
    const team = await createTeamAs(token, { name: 'Never shared' })
    const document = await createDocumentAs(token)

    // Owner + team both exist and the caller owns the doc, but no share row exists.
    const response = await app.inject({
      method: 'DELETE',
      url: `/teams/${team.id}/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(response.statusCode).toBe(404)
  })
})

// The /documents routes now resolve access through team membership (M5-3). These live here because the setup
// is team-heavy — a doc shared into a team the member belongs to — and this file already has the harness.
describe('/documents/:id — access through team membership', () => {
  // Owner shares a fresh document into a fresh team, then seats a fresh user in that team at `role`.
  const shareDocWithTeammate = async (
    role: 'viewer' | 'member' | 'admin',
  ): Promise<{
    ownerToken: string
    teammateToken: string
    documentId: string
    teamId: string
  }> => {
    const ownerToken = await signInNewUser(`docacc-owner-${role}`)
    const team = await createTeamAs(ownerToken, { name: `Team ${role}` })
    const document = await createDocumentAs(ownerToken, 'Shared doc')
    expect((await assignDocument(ownerToken, team.id, document.id)).statusCode).toBe(201)
    const teammate = await signInNewUserWithId(`docacc-${role}`)
    await addTeamMember(team.id, teammate.userId, role)
    return { ownerToken, teammateToken: teammate.token, documentId: document.id, teamId: team.id }
  }

  test('a team member can read a shared document and sees their access level', async () => {
    const { teammateToken, documentId } = await shareDocWithTeammate('member')
    const response = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}`,
      headers: authCookie(teammateToken),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ access: string }>().access).toBe('write')
  })

  test('the owner’s own access reads as "owner"', async () => {
    const { ownerToken, documentId } = await shareDocWithTeammate('member')
    const response = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}`,
      headers: authCookie(ownerToken),
    })
    expect(response.json<{ access: string }>().access).toBe('owner')
  })

  test('a member can rename the document', async () => {
    const { teammateToken, documentId } = await shareDocWithTeammate('member')
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${documentId}`,
      headers: authCookie(teammateToken),
      payload: { title: 'Renamed by member' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ document: { title: string } }>().document.title).toBe(
      'Renamed by member',
    )
  })

  test('a viewer cannot rename — 403, not 404 (they can see the doc)', async () => {
    const { teammateToken, documentId } = await shareDocWithTeammate('viewer')
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${documentId}`,
      headers: authCookie(teammateToken),
      payload: { title: 'nope' },
    })
    expect(response.statusCode).toBe(403)
  })

  test('even a team admin cannot delete the document — hard delete stays owner-only (403)', async () => {
    const { teammateToken, documentId } = await shareDocWithTeammate('admin')
    const response = await app.inject({
      method: 'DELETE',
      url: `/documents/${documentId}`,
      headers: authCookie(teammateToken),
    })
    expect(response.statusCode).toBe(403)
  })

  test('GET /documents/:id/teams — owner sees the share, member 403, stranger 404', async () => {
    const { ownerToken, teammateToken, documentId, teamId } = await shareDocWithTeammate('member')

    const ownerView = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/teams`,
      headers: authCookie(ownerToken),
    })
    expect(ownerView.statusCode).toBe(200)
    expect(ownerView.json<{ teams: { id: string }[] }>().teams.map((t) => t.id)).toContain(teamId)

    const memberView = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/teams`,
      headers: authCookie(teammateToken),
    })
    expect(memberView.statusCode).toBe(403)

    const strangerToken = await signInNewUser('docacc-stranger')
    const strangerView = await app.inject({
      method: 'GET',
      url: `/documents/${documentId}/teams`,
      headers: authCookie(strangerToken),
    })
    expect(strangerView.statusCode).toBe(404)
  })
})
