import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { type DocumentRow, documentsTable } from '../db/schema.ts'

// What the dashboard and editor header actually need — never the binary snapshot or the owner id.
// Dates leave here as Date objects; the JSON layer renders them as ISO strings on the wire.
export type DocumentSummary = {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
}

const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

// A new document starts truly empty — no snapshot, no update-log rows. Its CRDT state is seeded the
// first time someone opens it and types (step 2 M3), or by the PDF import pipeline (step 3). Passing
// title: undefined omits the column so the DB default ('Untitled document') applies.
export const createDocument = async (input: {
  ownerId: string
  title?: string
}): Promise<DocumentSummary> => {
  const [row] = await db
    .insert(documentsTable)
    .values({ ownerId: input.ownerId, title: input.title })
    .returning()
  if (row === undefined) {
    throw new Error('document insert returned no row')
  }
  return toSummary(row)
}

// The owner's documents, most-recently-touched first — the dashboard's list order.
export const listDocumentsForOwner = async (ownerId: string): Promise<DocumentSummary[]> => {
  const rows = await db
    .select()
    .from(documentsTable)
    .where(eq(documentsTable.ownerId, ownerId))
    .orderBy(desc(documentsTable.updatedAt))
  return rows.map(toSummary)
}

// One document's metadata, scoped to its owner. A bad id OR another user's document both return null;
// the owner match IS the authorization (no teams yet — step 4). The ws sync layer reuses the same
// owner check on upgrade, so "can read this doc over REST" and "can join its room" never diverge.
export const getDocumentForOwner = async (input: {
  documentId: string
  ownerId: string
}): Promise<DocumentSummary | null> => {
  const [row] = await db
    .select()
    .from(documentsTable)
    .where(and(eq(documentsTable.id, input.documentId), eq(documentsTable.ownerId, input.ownerId)))
    .limit(1)
  return row === undefined ? null : toSummary(row)
}

// Delete the owner's document; the FK cascade takes its update log with it. Returns whether a row was
// actually removed, so the route answers 404 for a bad id or a document that isn't the caller's.
export const deleteDocumentForOwner = async (input: {
  documentId: string
  ownerId: string
}): Promise<boolean> => {
  const removed = await db
    .delete(documentsTable)
    .where(and(eq(documentsTable.id, input.documentId), eq(documentsTable.ownerId, input.ownerId)))
    .returning({ id: documentsTable.id })
  return removed.length > 0
}
