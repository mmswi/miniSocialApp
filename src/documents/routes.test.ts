import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { db } from '../db/client.ts'
import { usersTable } from '../db/schema.ts'
import { buildServer } from '../server.ts'

// Integration tests against the real /documents routes through Fastify's in-process inject. Signup is
// uniform (no auto-login), so an authenticated session is earned the way a real user does: sign up,
// then log in. Throwaway emails, cleaned up afterward.
const app = buildServer()
const createdEmails: string[] = []
const password = 'correct horse battery staple'

type InjectResponse = Awaited<ReturnType<typeof app.inject>>

const uniqueEmail = (prefix: string): string => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  return email
}

const sessionTokenFrom = (response: InjectResponse): string | undefined =>
  response.cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value

// A logged-in session cookie value for a brand-new user.
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

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
  }
  await app.close()
})

describe('/documents', () => {
  test('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/documents' })
    expect(response.statusCode).toBe(401)
  })

  test('create → list → get round-trips for the owner', async () => {
    const token = await signInNewUser('doc-route-owner')

    const created = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: authCookie(token),
      payload: { title: 'Launch plan' },
    })
    expect(created.statusCode).toBe(201)
    const { document } = created.json<{ document: { id: string; title: string } }>()
    expect(document.title).toBe('Launch plan')

    const listed = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: authCookie(token),
    })
    const { documents } = listed.json<{ documents: { id: string }[] }>()
    expect(documents.map((d) => d.id)).toContain(document.id)

    const fetched = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json<{ document: { title: string } }>().document.title).toBe('Launch plan')
  })

  test('creating with no title yields the default', async () => {
    const token = await signInNewUser('doc-route-default')
    const created = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: authCookie(token),
      payload: {},
    })
    expect(created.json<{ document: { title: string } }>().document.title).toBe('Untitled document')
  })

  test("another user's document is reported 404, not 403 — no existence oracle", async () => {
    const ownerToken = await signInNewUser('doc-route-secret-owner')
    const created = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: authCookie(ownerToken),
      payload: { title: 'secret' },
    })
    const { document } = created.json<{ document: { id: string } }>()

    const strangerToken = await signInNewUser('doc-route-stranger')
    const asStranger = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: authCookie(strangerToken),
    })
    expect(asStranger.statusCode).toBe(404)

    const strangerDelete = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: authCookie(strangerToken),
    })
    expect(strangerDelete.statusCode).toBe(404)
    // The owner still has it — the stranger's delete was a no-op, not a silent success.
    const ownerStillSees = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: authCookie(ownerToken),
    })
    expect(ownerStillSees.statusCode).toBe(200)
  })

  test('a non-uuid id is a 400, not a 404', async () => {
    const token = await signInNewUser('doc-route-badid')
    const response = await app.inject({
      method: 'GET',
      url: '/documents/not-a-uuid',
      headers: authCookie(token),
    })
    expect(response.statusCode).toBe(400)
  })

  test('the owner can delete their own document', async () => {
    const token = await signInNewUser('doc-route-delete')
    const created = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: authCookie(token),
      payload: { title: 'throwaway' },
    })
    const { document } = created.json<{ document: { id: string } }>()
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(deleted.statusCode).toBe(204)
    const afterDelete = await app.inject({
      method: 'GET',
      url: `/documents/${document.id}`,
      headers: authCookie(token),
    })
    expect(afterDelete.statusCode).toBe(404)
  })
})
