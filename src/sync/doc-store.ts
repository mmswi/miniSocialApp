import { and, asc, eq, gt } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '../db/client.ts'
import { documentUpdates, documents } from '../db/schema.ts'

// Rebuild a document's live CRDT from its durable home: the compacted snapshot (everything folded in
// up through snapshotThrough) plus every update appended since, replayed in seq order. A brand-new doc
// — no snapshot, no updates — yields an empty Y.Doc, which is exactly right: it has no content until
// someone types. Throws for an id that does not exist, so a room is never built on a phantom document.
export const loadDoc = async (documentId: string): Promise<Y.Doc> => {
  const [meta] = await db
    .select({ snapshot: documents.snapshot, snapshotThrough: documents.snapshotThrough })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  if (meta === undefined) {
    throw new Error(`loadDoc: document ${documentId} does not exist`)
  }

  const pendingUpdates = await db
    .select({ update: documentUpdates.update })
    .from(documentUpdates)
    .where(
      and(
        eq(documentUpdates.documentId, documentId),
        gt(documentUpdates.seq, meta.snapshotThrough),
      ),
    )
    .orderBy(asc(documentUpdates.seq))

  const doc = new Y.Doc()
  // Snapshot first, then the tail of newer updates in order. Yjs updates are commutative so order can't
  // corrupt state, but seq order keeps the rebuild deterministic and identical to what was edited live.
  if (meta.snapshot !== null) {
    Y.applyUpdate(doc, meta.snapshot)
  }
  for (const row of pendingUpdates) {
    Y.applyUpdate(doc, row.update)
  }
  return doc
}

// Append one Yjs update to the log the instant the sync server receives it — durable before the editor
// even repaints, which is what closes the "process died before the debounced flush" data-loss window.
// The compactor (M4) later folds these into a snapshot and trims them.
export const appendUpdate = (documentId: string, update: Uint8Array): Promise<unknown> =>
  db.insert(documentUpdates).values({ documentId, update })
