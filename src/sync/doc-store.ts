import { asc, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '../db/client.ts'
import { documentUpdatesTable, documentsTable } from '../db/schema.ts'

// Rebuild a document's live CRDT from its durable home: the compacted snapshot plus every update row
// still in the log, replayed in seq order. The compactor deletes exactly the rows it folds, so whatever
// remains IS the un-folded tail — we replay all of it, no "seq > watermark" filter. (A watermark would
// strand a late-committing lower seq, since bigserial assigns seq at insert but commits land out of
// order — see schema.ts and compaction.ts.) A brand-new doc — no snapshot, no updates — yields an empty
// Y.Doc, which is exactly right: no content until someone types. Throws for an id that does not exist,
// so a room is never built on a phantom document.
export const loadDoc = async (documentId: string): Promise<Y.Doc> => {
  const [meta] = await db
    .select({ snapshot: documentsTable.snapshot })
    .from(documentsTable)
    .where(eq(documentsTable.id, documentId))
    .limit(1)
  if (meta === undefined) {
    throw new Error(`loadDoc: document ${documentId} does not exist`)
  }

  const pendingUpdates = await db
    .select({ update: documentUpdatesTable.update })
    .from(documentUpdatesTable)
    .where(eq(documentUpdatesTable.documentId, documentId))
    .orderBy(asc(documentUpdatesTable.seq))

  const doc = new Y.Doc()
  // Snapshot first, then every remaining update in seq order. Yjs updates are commutative so order can't
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
  db.insert(documentUpdatesTable).values({ documentId, update })
