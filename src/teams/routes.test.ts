import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { db } from '../db/client.ts'
import { teamsTable, usersTable } from '../db/schema.ts'
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
  body: { name: string; accessLevel?: string },
): Promise<{ id: string; name: string; accessLevel: string }> => {
  const response = await app.inject({
    method: 'POST',
    url: '/teams',
    headers: authCookie(token),
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  const { team } = response.json<{ team: { id: string; name: string; accessLevel: string } }>()
  createdTeamIds.push(team.id)
  return team
}

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

  test('create → list → get round-trips for the creator, who is the owner', async () => {
    const token = await signInNewUser('team-owner')
    const created = await createTeamAs(token, { name: 'Launch team' })
    expect(created.name).toBe('Launch team')

    const listed = await app.inject({ method: 'GET', url: '/teams', headers: authCookie(token) })
    const { teams } = listed.json<{ teams: { id: string; role: string }[] }>()
    expect(teams.map((t) => t.id)).toContain(created.id)
    expect(teams.find((t) => t.id === created.id)?.role).toBe('owner')

    const fetched = await app.inject({
      method: 'GET',
      url: `/teams/${created.id}`,
      headers: authCookie(token),
    })
    expect(fetched.statusCode).toBe(200)
    const body = fetched.json<{ team: { name: string }; role: string }>()
    expect(body.team.name).toBe('Launch team')
    expect(body.role).toBe('owner')
  })

  test('a team with no access level defaults to read', async () => {
    const token = await signInNewUser('team-default')
    const created = await createTeamAs(token, { name: 'Readers' })
    expect(created.accessLevel).toBe('read')
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

  test('an unknown access level is a 400', async () => {
    const token = await signInNewUser('team-badlevel')
    const response = await app.inject({
      method: 'POST',
      url: '/teams',
      headers: authCookie(token),
      payload: { name: 'Bad', accessLevel: 'admin' },
    })
    expect(response.statusCode).toBe(400)
  })

  test("a non-member gets 404 for someone else's team — never 403, no existence oracle", async () => {
    const ownerToken = await signInNewUser('team-secret-owner')
    const created = await createTeamAs(ownerToken, { name: 'secret' })

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
})
