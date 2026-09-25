import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { generateToken, hashToken } from '../auth/tokens.ts'
import { db } from '../db/client.ts'
import { teamInvitesTable, teamMembersTable, teamsTable, usersTable } from '../db/schema.ts'
import { sentEmails } from '../lib/email.ts'
import { buildServer } from '../server.ts'

// Integration tests against the real /teams invite routes through Fastify's in-process inject. Sessions are
// earned the way a real user does — sign up, then log in — so we can act as superadmin, admin, member, and
// stranger. Throwaway emails + teams, cleaned up afterward (deleting a team cascades its invites/members).
const app = buildServer()
const createdEmails: string[] = []
const createdTeamIds: string[] = []
const password = 'correct horse battery staple'

type InjectResponse = Awaited<ReturnType<typeof app.inject>>
type Actor = { token: string; email: string }

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

const sessionTokenFrom = (response: InjectResponse): string | undefined =>
  response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value

// Sign up + log in a fresh user; returns their session token AND their (normalized) email — invite tests
// need the email to address an invite at a specific person and to assert the accept-time match.
const signInNewUser = async (prefix: string): Promise<Actor> => {
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
  return { token, email: email.toLowerCase() }
}

const authCookie = (token: string): { cookie: string } => ({
  cookie: `${SESSION_COOKIE_NAME}=${token}`,
})

const createTeamAs = async (actor: Actor, body: { name: string }): Promise<string> => {
  const response = await app.inject({
    method: 'POST',
    url: '/teams',
    headers: authCookie(actor.token),
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  const { team } = response.json<{ team: { id: string } }>()
  createdTeamIds.push(team.id)
  return team.id
}

// The raw token only ever leaves the server in the emailed link. Pull it back out the way the auth E2E
// reads its verification token — off the in-memory `sentEmails`, scanning only the messages added since a
// captured baseline so a stray signup email can't be mistaken for the invite.
const inviteTokenSince = (baseline: number): string => {
  for (let i = sentEmails.length - 1; i >= baseline; i--) {
    const match = sentEmails[i]?.text.match(/inviteToken=([^\s]+)/)
    if (match?.[1] !== undefined) {
      return match[1]
    }
  }
  throw new Error('no invite email with a token was sent')
}

// Invite `email` to a team over HTTP and hand back both the response and (on success) the raw token.
const inviteAs = async (
  actor: Actor,
  teamId: string,
  email: string,
  role: string,
): Promise<{ response: InjectResponse; rawToken: string | undefined }> => {
  const baseline = sentEmails.length
  const response = await app.inject({
    method: 'POST',
    url: `/teams/${teamId}/invites`,
    headers: authCookie(actor.token),
    payload: { email, role },
  })
  const rawToken = response.statusCode === 201 ? inviteTokenSince(baseline) : undefined
  return { response, rawToken }
}

const acceptAs = async (actor: Actor, rawToken: string): Promise<InjectResponse> =>
  app.inject({
    method: 'POST',
    url: '/teams/invites/accept',
    headers: authCookie(actor.token),
    payload: { token: rawToken },
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

describe('team invites', () => {
  test('every mutating invite route rejects an unauthenticated request with 401', async () => {
    const teamId = randomUUID()
    const unauth = [
      {
        method: 'POST' as const,
        url: `/teams/${teamId}/invites`,
        payload: { email: 'a@b.c', role: 'member' },
      },
      { method: 'GET' as const, url: `/teams/${teamId}/invites` },
      { method: 'DELETE' as const, url: `/teams/${teamId}/invites/${randomUUID()}` },
      { method: 'POST' as const, url: '/teams/invites/accept', payload: { token: 'x' } },
    ]
    for (const req of unauth) {
      expect((await app.inject(req)).statusCode).toBe(401)
    }
  })

  test('the preview route is public — no session needed — and unknown tokens are an indistinguishable 400', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/teams/invites/preview?token=totally-made-up',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ error: string }>().error).toBe('invalid_invite')
  })

  test('a non-member gets 404, never 403, on EVERY team-scoped invite route — no existence oracle', async () => {
    const superadmin = await signInNewUser('inv-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Private' })
    const stranger = await signInNewUser('inv-stranger')

    // Invite (POST), list (GET), and revoke (DELETE) all guard on membership first, so a stranger can't
    // tell a team they're excluded from apart from one that doesn't exist.
    const invite = await inviteAs(stranger, teamId, 'anyone@example.test', 'member')
    expect(invite.response.statusCode).toBe(404)

    const list = await app.inject({
      method: 'GET',
      url: `/teams/${teamId}/invites`,
      headers: authCookie(stranger.token),
    })
    expect(list.statusCode).toBe(404)

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/teams/${teamId}/invites/${randomUUID()}`,
      headers: authCookie(stranger.token),
    })
    expect(revoke.statusCode).toBe(404)
  })

  test('the superadmin invites → row stored as a hash only, email carries the link, preview reads it back', async () => {
    const superadmin = await signInNewUser('inv-hash-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Hashers' })
    const invitee = uniqueEmail('inv-hash-target')
    const { response, rawToken } = await inviteAs(superadmin, teamId, invitee, 'member')
    expect(response.statusCode).toBe(201)
    if (rawToken === undefined) {
      throw new Error('expected an invite token in the email')
    }

    // At rest, the id is sha256(rawToken) and the raw token appears in no column.
    const [row] = await db
      .select()
      .from(teamInvitesTable)
      .where(eq(teamInvitesTable.id, hashToken(rawToken)))
      .limit(1)
    expect(row?.email).toBe(invitee.toLowerCase())
    expect(row?.role).toBe('member')
    expect(JSON.stringify(row)).not.toContain(rawToken)

    // The public preview unlocks exactly what the holder needs to render the accept screen.
    const preview = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${rawToken}`,
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json<{ invite: { teamName: string; email: string; role: string } }>()
    expect(body.invite.teamName).toBe('Hashers')
    expect(body.invite.email).toBe(invitee.toLowerCase())
    expect(body.invite.role).toBe('member')
  })

  test('accept seats the invitee, is single-use, and the membership is real', async () => {
    const superadmin = await signInNewUser('inv-accept-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Joiners' })
    const invitee = await signInNewUser('inv-accept-target')
    const { rawToken } = await inviteAs(superadmin, teamId, invitee.email, 'member')
    if (rawToken === undefined) {
      throw new Error('expected an invite token')
    }

    const accepted = await acceptAs(invitee, rawToken)
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json<{ team: { teamId: string } }>().team.teamId).toBe(teamId)

    // The invitee can now see the team as a member.
    const asMember = await app.inject({
      method: 'GET',
      url: `/teams/${teamId}`,
      headers: authCookie(invitee.token),
    })
    expect(asMember.statusCode).toBe(200)
    expect(asMember.json<{ role: string }>().role).toBe('member')

    // The token is burned — a second accept finds no row and is the same 400 as a made-up token.
    const replay = await acceptAs(invitee, rawToken)
    expect(replay.statusCode).toBe(400)
    expect(replay.json<{ error: string }>().error).toBe('invalid_invite')
  })

  test('accepting an invite addressed to a different email is 403 and does NOT consume the token', async () => {
    const superadmin = await signInNewUser('inv-mismatch-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Bound' })
    const intended = uniqueEmail('inv-mismatch-intended')
    const wrongPerson = await signInNewUser('inv-mismatch-wrong')
    const { rawToken } = await inviteAs(superadmin, teamId, intended, 'member')
    if (rawToken === undefined) {
      throw new Error('expected an invite token')
    }

    const mismatch = await acceptAs(wrongPerson, rawToken)
    expect(mismatch.statusCode).toBe(403)
    expect(mismatch.json<{ error: string }>().error).toBe('invite_email_mismatch')

    // Not consumed: the intended recipient can still preview (and later accept) the very same link.
    const stillLive = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${rawToken}`,
    })
    expect(stillLive.statusCode).toBe(200)
  })

  test('inviting someone who is already a member is a 409, not a dead invite', async () => {
    const superadmin = await signInNewUser('inv-dup-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Full house' })
    const member = await signInNewUser('inv-dup-member')
    const { rawToken } = await inviteAs(superadmin, teamId, member.email, 'member')
    if (rawToken === undefined) {
      throw new Error('expected an invite token')
    }
    expect((await acceptAs(member, rawToken)).statusCode).toBe(200)

    const { response } = await inviteAs(superadmin, teamId, member.email, 'member')
    expect(response.statusCode).toBe(409)
    expect(response.json<{ error: string }>().error).toBe('already_member')
  })

  test('re-inviting the same email rotates the token — the previous link stops working', async () => {
    const superadmin = await signInNewUser('inv-rotate-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Rotators' })
    const invitee = uniqueEmail('inv-rotate-target')
    const first = await inviteAs(superadmin, teamId, invitee, 'member')
    const second = await inviteAs(superadmin, teamId, invitee, 'member')
    if (first.rawToken === undefined || second.rawToken === undefined) {
      throw new Error('expected two invite tokens')
    }
    expect(second.rawToken).not.toBe(first.rawToken)

    const oldLink = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${first.rawToken}`,
    })
    expect(oldLink.statusCode).toBe(400)
    const newLink = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${second.rawToken}`,
    })
    expect(newLink.statusCode).toBe(200)
  })

  test('an expired invite previews as 400 invite_expired and the dead row is deleted', async () => {
    const superadmin = await signInNewUser('inv-expired-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Lapsed' })
    const [superadminRow] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, superadmin.email))
      .limit(1)
    if (superadminRow === undefined) {
      throw new Error('expected the superadmin user row')
    }
    // Insert a past-dated invite directly — the 7-day TTL is too long to wait out in a test.
    const rawToken = generateToken()
    const id = hashToken(rawToken)
    await db.insert(teamInvitesTable).values({
      id,
      teamId,
      email: uniqueEmail('inv-expired-target').toLowerCase(),
      role: 'member',
      invitedById: superadminRow.id,
      expiresAt: new Date(Date.now() - 1000),
    })

    const preview = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${rawToken}`,
    })
    expect(preview.statusCode).toBe(400)
    expect(preview.json<{ error: string }>().error).toBe('invite_expired')

    // The expired row was cleaned up as a side effect of the failed preview.
    const remaining = await db
      .select({ id: teamInvitesTable.id })
      .from(teamInvitesTable)
      .where(eq(teamInvitesTable.id, id))
    expect(remaining.length).toBe(0)
  })

  test('an admin invites members and viewers; only the superadmin invites an admin', async () => {
    const superadmin = await signInNewUser('inv-role-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Ranks' })

    const adminToBe = await signInNewUser('inv-role-admin')
    const asAdmin = await inviteAs(superadmin, teamId, adminToBe.email, 'admin')
    expect(asAdmin.response.statusCode).toBe(201)
    if (asAdmin.rawToken === undefined) {
      throw new Error('expected an admin invite token')
    }
    expect((await acceptAs(adminToBe, asAdmin.rawToken)).statusCode).toBe(200)

    for (const role of ['member', 'viewer']) {
      const invite = await inviteAs(adminToBe, teamId, uniqueEmail(`inv-role-${role}`), role)
      expect(invite.response.statusCode).toBe(201)
    }
    const adminByAdmin = await inviteAs(adminToBe, teamId, uniqueEmail('inv-role-peer'), 'admin')
    expect(adminByAdmin.response.statusCode).toBe(403)
    expect(adminByAdmin.response.json<{ error: string }>().error).toBe(
      'invite_admin_requires_superadmin',
    )
  })

  test('an invite as viewer seats the invitee as a viewer', async () => {
    const superadmin = await signInNewUser('inv-viewer-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Readers' })
    const invitee = await signInNewUser('inv-viewer-target')
    const { rawToken } = await inviteAs(superadmin, teamId, invitee.email, 'viewer')
    if (rawToken === undefined) {
      throw new Error('expected a viewer invite token')
    }
    expect((await acceptAs(invitee, rawToken)).statusCode).toBe(200)

    const asViewer = await app.inject({
      method: 'GET',
      url: `/teams/${teamId}`,
      headers: authCookie(invitee.token),
    })
    expect(asViewer.json<{ role: string }>().role).toBe('viewer')
  })

  test('a plain member can neither invite nor list invites', async () => {
    const superadmin = await signInNewUser('inv-member-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Gated' })
    const member = await signInNewUser('inv-member-plain')
    const { rawToken } = await inviteAs(superadmin, teamId, member.email, 'member')
    if (rawToken === undefined) {
      throw new Error('expected an invite token')
    }
    expect((await acceptAs(member, rawToken)).statusCode).toBe(200)

    const invite = await inviteAs(member, teamId, uniqueEmail('inv-member-target'), 'member')
    expect(invite.response.statusCode).toBe(403)

    const list = await app.inject({
      method: 'GET',
      url: `/teams/${teamId}/invites`,
      headers: authCookie(member.token),
    })
    expect(list.statusCode).toBe(403)
  })

  test('an admin lists and revokes an outstanding invite; the revoked link then fails', async () => {
    const superadmin = await signInNewUser('inv-revoke-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Revocable' })
    const invitee = uniqueEmail('inv-revoke-target')
    const { rawToken } = await inviteAs(superadmin, teamId, invitee, 'member')
    if (rawToken === undefined) {
      throw new Error('expected an invite token')
    }

    const list = await app.inject({
      method: 'GET',
      url: `/teams/${teamId}/invites`,
      headers: authCookie(superadmin.token),
    })
    expect(list.statusCode).toBe(200)
    const { invites } = list.json<{ invites: { id: string; email: string }[] }>()
    const pending = invites.find((invite) => invite.email === invitee.toLowerCase())
    expect(pending).toBeDefined()
    if (pending === undefined) {
      throw new Error('expected the pending invite in the list')
    }

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/teams/${teamId}/invites/${pending.id}`,
      headers: authCookie(superadmin.token),
    })
    expect(revoke.statusCode).toBe(204)

    const deadLink = await app.inject({
      method: 'GET',
      url: `/teams/invites/preview?token=${rawToken}`,
    })
    expect(deadLink.statusCode).toBe(400)

    // Revoking again finds nothing to delete → 404.
    const revokeAgain = await app.inject({
      method: 'DELETE',
      url: `/teams/${teamId}/invites/${pending.id}`,
      headers: authCookie(superadmin.token),
    })
    expect(revokeAgain.statusCode).toBe(404)
  })

  test('accepting when already a member is idempotent — no duplicate row, invite still cleared', async () => {
    const superadmin = await signInNewUser('inv-idem-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Idempotent' })
    const member = await signInNewUser('inv-idem-member')
    const [memberRow] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, member.email))
      .limit(1)
    if (memberRow === undefined) {
      throw new Error('expected the member user row')
    }

    // Seat them directly, then hand them an invite for a team they're already in (a state the invite-time
    // 409 normally prevents, constructed here to prove accept itself is idempotent).
    await db.insert(teamMembersTable).values({ teamId, userId: memberRow.id, role: 'member' })
    const rawToken = generateToken()
    await db.insert(teamInvitesTable).values({
      id: hashToken(rawToken),
      teamId,
      email: member.email,
      role: 'member',
      invitedById: memberRow.id,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const accepted = await acceptAs(member, rawToken)
    expect(accepted.statusCode).toBe(200)

    // Exactly one membership for this (team, user), and the invite is gone.
    const memberships = await db
      .select({ id: teamMembersTable.id })
      .from(teamMembersTable)
      .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.userId, memberRow.id)))
    expect(memberships.length).toBe(1)
    const leftoverInvite = await db
      .select({ id: teamInvitesTable.id })
      .from(teamInvitesTable)
      .where(eq(teamInvitesTable.id, hashToken(rawToken)))
    expect(leftoverInvite.length).toBe(0)
  })

  test('a malformed invite body is a 400 — bad email, and a role that is not member/admin', async () => {
    const superadmin = await signInNewUser('inv-validate-superadmin')
    const teamId = await createTeamAs(superadmin, { name: 'Strict' })
    const badEmail = await app.inject({
      method: 'POST',
      url: `/teams/${teamId}/invites`,
      headers: authCookie(superadmin.token),
      payload: { email: 'not-an-email', role: 'member' },
    })
    expect(badEmail.statusCode).toBe(400)
    const badRole = await app.inject({
      method: 'POST',
      url: `/teams/${teamId}/invites`,
      headers: authCookie(superadmin.token),
      payload: { email: 'ok@example.test', role: 'superadmin' },
    })
    expect(badRole.statusCode).toBe(400)
  })
})
