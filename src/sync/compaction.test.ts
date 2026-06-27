import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { count, eq, inArray } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '../db/client.ts'
import { documentUpdatesTable, documentsTable, usersTable } from '../db/schema.ts'
import {
  compactDocument,
  compactPendingDocuments,
  findDocumentsNeedingCompaction,
} from './compaction.ts'
import { appendUpdate, loadDoc } from './doc-store.ts'

// Integration tests against real Postgres (no server, no sockets — compaction is a pure data-layer
// operation). They prove the two-tier persistence contract: a fold reconstructs identical content,
// deletes EXACTLY the rows it folded, and updates appended after a fold still load on top of the
// snapshot. The sweep selects only documents whose un-folded tail crossed the threshold.

const SHARED_TEXT = 'content'

const createdEmails: string[] = []
let ownerId = ''

const seedOwner = async (): Promise<string> => {
  const email = `compaction-owner-${randomUUID()}@example.test`
  createdEmails.push(email)
  const [user] = await db.insert(usersTable).values({ email }).returning()
  if (user === undefined) {
    throw new Error('failed to seed user')
  }
  return user.id
}

const freshDocument = async (): Promise<string> => {
  const [doc] = await db
    .insert(documentsTable)
    .values({ ownerId, title: 'compaction test' })
    .returning()
  if (doc === undefined) {
    throw new Error('failed to seed document')
  }
  return doc.id
}

// Build a deterministic stream of Yjs updates from one evolving doc: each insert is its own
// transaction, so Yjs emits exactly one update per text fragment. Replaying them in order rebuilds
// `finalText`, which is what the snapshot must reproduce.
const collectUpdates = (fragments: string[]): { updates: Uint8Array[]; finalText: string } => {
  const source = new Y.Doc()
  const updates: Uint8Array[] = []
  source.on('update', (update: Uint8Array) => updates.push(update))
  const shared = source.getText(SHARED_TEXT)
  for (const fragment of fragments) {
    shared.insert(shared.length, fragment)
  }
  const finalText = shared.toString()
  source.destroy()
  return { updates, finalText }
}

const countUpdates = async (documentId: string): Promise<number> => {
  const [row] = await db
    .select({ pending: count() })
    .from(documentUpdatesTable)
    .where(eq(documentUpdatesTable.documentId, documentId))
  return row?.pending ?? 0
}

const textOf = async (documentId: string): Promise<string> => {
  const doc = await loadDoc(documentId)
  const text = doc.getText(SHARED_TEXT).toString()
  doc.destroy()
  return text
}

beforeAll(async () => {
  ownerId = await seedOwner()
})

afterAll(async () => {
  if (createdEmails.length > 0) {
    // FK cascade takes the documents and their update rows with the users.
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
  }
})

describe('compaction (tier 2 of two-tier persistence)', () => {
  test('folds the log into a snapshot, trims the folded rows, and reloads identical content', async () => {
    const documentId = await freshDocument()
    const { updates, finalText } = collectUpdates(['Hello', ' world', '!'])
    for (const update of updates) {
      await appendUpdate(documentId, update)
    }
    expect(await countUpdates(documentId)).toBe(3)

    const result = await compactDocument(documentId)
    expect(result).toEqual({ status: 'compacted', folded: 3 })

    // The folded rows are gone, and a non-null snapshot now stands in for them.
    expect(await countUpdates(documentId)).toBe(0)
    const [doc] = await db
      .select({ snapshot: documentsTable.snapshot })
      .from(documentsTable)
      .where(eq(documentsTable.id, documentId))
    expect(doc?.snapshot).not.toBeNull()

    // Load reconstructs the exact pre-compaction content from the snapshot alone.
    expect(await textOf(documentId)).toBe(finalText)
  })

  test('updates appended AFTER a fold replay on top of the snapshot (and only they remain)', async () => {
    const documentId = await freshDocument()
    const { updates, finalText } = collectUpdates(['one ', 'two ', 'three ', 'four ', 'five'])

    for (const update of updates.slice(0, 3)) {
      await appendUpdate(documentId, update)
    }
    await compactDocument(documentId)
    expect(await countUpdates(documentId)).toBe(0)

    for (const update of updates.slice(3)) {
      await appendUpdate(documentId, update)
    }
    // Delete-exactly-what-you-fold: only the two post-fold rows are in the log now.
    expect(await countUpdates(documentId)).toBe(2)

    // snapshot (one..three) + replay (four, five) = the whole document.
    expect(await textOf(documentId)).toBe(finalText)
  })

  test('a late-committing lower seq survives a fold (the commit-reordering a watermark would drop)', async () => {
    const documentId = await freshDocument()
    // Two INDEPENDENT edits from different clients, so each applies on its own with no missing dependency.
    const makeUpdate = (fragment: string): Uint8Array => {
      const source = new Y.Doc()
      const captured: Uint8Array[] = []
      source.on('update', (update: Uint8Array) => captured.push(update))
      source.getText(SHARED_TEXT).insert(0, fragment)
      source.destroy()
      const [update] = captured
      if (update === undefined) {
        throw new Error('makeUpdate captured no update')
      }
      return update
    }
    const earlyUpdate = makeUpdate('AAA') // grabs the LOWER seq first, but commits LAST
    const lateUpdate = makeUpdate('BBB') // grabs the HIGHER seq, but commits FIRST

    // The held transaction keeps `earlyUpdate` uncommitted (so invisible to the compactor) while a later
    // update lands, commits, and gets folded. appendUpdate + compactDocument use the global db — separate
    // pool connections — so they see only committed rows. This reproduces the exact bigserial race:
    // a lower seq still in flight when a higher seq is already visible.
    await db.transaction(async (tx) => {
      await tx.insert(documentUpdatesTable).values({ documentId, update: earlyUpdate }) // seq N, held open
      await appendUpdate(documentId, lateUpdate) // seq N+1, committed immediately

      // The compactor can only see the committed higher-seq row; it folds and deletes exactly that one.
      const result = await compactDocument(documentId)
      expect(result).toEqual({ status: 'compacted', folded: 1 })
      // The transaction commits here on return — earlyUpdate (seq N) becomes visible only now.
    })

    // earlyUpdate is still in the un-folded tail (it was never in the folded set), so load replays it on
    // top of the snapshot. A "seq > snapshotThrough" watermark would have skipped it — the edit gone.
    const text = await textOf(documentId)
    expect(text.length).toBe(6)
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })

  test('re-compacting a fully folded document is a no-op', async () => {
    const documentId = await freshDocument()
    const { updates, finalText } = collectUpdates(['stable text'])
    for (const update of updates) {
      await appendUpdate(documentId, update)
    }
    await compactDocument(documentId)

    expect(await compactDocument(documentId)).toEqual({ status: 'nothing-to-fold' })
    expect(await textOf(documentId)).toBe(finalText)
  })

  test('a brand-new document has nothing to fold', async () => {
    const documentId = await freshDocument()
    expect(await compactDocument(documentId)).toEqual({ status: 'nothing-to-fold' })
  })

  test('compacting a non-existent document reports document-missing', async () => {
    expect(await compactDocument(randomUUID())).toEqual({ status: 'document-missing' })
  })

  test('findDocumentsNeedingCompaction returns only documents at or over the threshold', async () => {
    const under = await freshDocument()
    const over = await freshDocument()
    const { updates: underUpdates } = collectUpdates(['a', 'b']) // 2 rows
    const { updates: overUpdates } = collectUpdates(['a', 'b', 'c', 'd']) // 4 rows
    for (const update of underUpdates) {
      await appendUpdate(under, update)
    }
    for (const update of overUpdates) {
      await appendUpdate(over, update)
    }

    const targets = await findDocumentsNeedingCompaction(3)
    expect(targets).toContain(over)
    expect(targets).not.toContain(under)
  })

  test('the sweep folds over-threshold documents and leaves the rest untouched', async () => {
    const under = await freshDocument()
    const over = await freshDocument()
    const { updates: underUpdates, finalText: underText } = collectUpdates(['x', 'y']) // 2 rows
    const { updates: overUpdates, finalText: overText } = collectUpdates(['x', 'y', 'z', 'w']) // 4 rows
    for (const update of underUpdates) {
      await appendUpdate(under, update)
    }
    for (const update of overUpdates) {
      await appendUpdate(over, update)
    }

    const result = await compactPendingDocuments(3)
    expect(result.compacted).toBeGreaterThanOrEqual(1)

    // The over-threshold doc was folded (tail trimmed); the under-threshold one was skipped.
    expect(await countUpdates(over)).toBe(0)
    expect(await countUpdates(under)).toBe(2)
    // Content is preserved on both — folding never changes what loads.
    expect(await textOf(over)).toBe(overText)
    expect(await textOf(under)).toBe(underText)
  })
})
