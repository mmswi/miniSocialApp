import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { users } from '../db/schema.ts'
import {
  createDocument,
  deleteDocumentForOwner,
  getDocumentForOwner,
  listDocumentsForOwner,
} from './documents.ts'

// Integration tests against the dockerized Postgres. Two throwaway users (an owner and a stranger)
// so the owner-scoping checks are real — a stranger must never reach the owner's document.
const ownerEmail = `doc-owner-${randomUUID()}@example.test`
const strangerEmail = `doc-stranger-${randomUUID()}@example.test`
let ownerId = ''
let strangerId = ''

beforeAll(async () => {
  const seeded = await db
    .insert(users)
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
  // Deleting the users cascades to their documents, which cascades to the update log.
  await db.delete(users).where(inArray(users.email, [ownerEmail, strangerEmail]))
})

describe('documents data access', () => {
  test('a created document defaults to "Untitled document" and is empty', async () => {
    const doc = await createDocument({ ownerId })
    expect(doc.title).toBe('Untitled document')
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a title is used when provided', async () => {
    const doc = await createDocument({ ownerId, title: 'Q3 strategy memo' })
    expect(doc.title).toBe('Q3 strategy memo')
  })

  test('the list returns only the owner’s documents, newest first', async () => {
    const isolatedOwner = (
      await db
        .insert(users)
        .values({ email: `doc-iso-${randomUUID()}@example.test` })
        .returning()
    )[0]
    if (isolatedOwner === undefined) {
      throw new Error('failed to seed isolated owner')
    }
    const first = await createDocument({ ownerId: isolatedOwner.id, title: 'first' })
    const second = await createDocument({ ownerId: isolatedOwner.id, title: 'second' })

    const listed = await listDocumentsForOwner(isolatedOwner.id)
    expect(listed.map((d) => d.id)).toEqual([second.id, first.id])

    await db.delete(users).where(inArray(users.id, [isolatedOwner.id]))
  })

  test('getDocumentForOwner returns the document for its owner', async () => {
    const created = await createDocument({ ownerId, title: 'mine' })
    const fetched = await getDocumentForOwner({ documentId: created.id, ownerId })
    expect(fetched?.title).toBe('mine')
  })

  test('getDocumentForOwner returns null for a stranger — never another user’s document', async () => {
    const created = await createDocument({ ownerId, title: 'private' })
    const asStranger = await getDocumentForOwner({ documentId: created.id, ownerId: strangerId })
    expect(asStranger).toBeNull()
  })

  test('getDocumentForOwner returns null for an unknown id', async () => {
    expect(await getDocumentForOwner({ documentId: randomUUID(), ownerId })).toBeNull()
  })

  test('a stranger cannot delete the owner’s document', async () => {
    const created = await createDocument({ ownerId, title: 'do not delete' })
    const strangerRemoved = await deleteDocumentForOwner({
      documentId: created.id,
      ownerId: strangerId,
    })
    expect(strangerRemoved).toBe(false)
    // Still there for its actual owner.
    expect(await getDocumentForOwner({ documentId: created.id, ownerId })).not.toBeNull()
  })

  test('the owner can delete their own document', async () => {
    const created = await createDocument({ ownerId, title: 'temporary' })
    expect(await deleteDocumentForOwner({ documentId: created.id, ownerId })).toBe(true)
    expect(await getDocumentForOwner({ documentId: created.id, ownerId })).toBeNull()
  })
})
