import { and, asc, count, eq, gte, inArray } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '../db/client.ts'
import { documentUpdatesTable, documentsTable } from '../db/schema.ts'

/*
 * Tier 2 of the two-tier persistence: fold a document's append-only update log into one compacted
 * snapshot, then delete exactly the rows that were folded. Tier 1 (the immediate append + the load
 * path) lives in doc-store.ts. Compaction runs as a periodic background sweep (the compaction worker),
 * never on the request path — it is purely an optimization that keeps the replay-on-load tail short.
 *
 *   documents.snapshot  +  document_updates (the un-folded tail)   =   the document
 *        ▲                          │
 *        └── compactDocument folds the tail into here, then deletes the rows it folded ──┘
 *
 * Two rules carry the correctness, both load-bearing:
 *
 *   1. ONE compactor per document. SELECT ... FOR NO KEY UPDATE on the documents row serializes
 *      overlapping sweeps (the lock conflicts with itself), so an older fold can never overwrite a newer
 *      one. The lock mode is deliberate: an INSERT into document_updates takes a FOR KEY SHARE lock on
 *      its parent documents row (the FK), and FOR NO KEY UPDATE does NOT conflict with FOR KEY SHARE —
 *      so the fold never blocks concurrent appends, and they never block it. (Plain FOR UPDATE *would*
 *      conflict with the FK's key-share lock, stalling every append for the whole fold — exactly the
 *      lock-free-append property this design promises, lost.)
 *
 *   2. Delete EXACTLY the rows we folded (by seq), never "seq <= max". `seq` is a bigserial assigned at
 *      INSERT, but commits land out of order, so a lower seq can still be uncommitted (invisible) when a
 *      higher one is already visible. "Delete <= max" would drop that late row before it was ever folded
 *      — silent data loss. Folding the rows we can see and deleting that exact set leaves any late row in
 *      the log for the next sweep; load replays the whole remaining tail, so it is never lost.
 */

// How many un-folded updates a document accumulates before the sweep bothers to fold it. Low enough that
// load stays cheap (the replay tail is bounded), high enough that we're not re-snapshotting on every
// keystroke. The append log already guarantees durability, so this is a tuning knob, not a correctness
// one — folding more or less often only changes how much load has to replay.
export const COMPACTION_THRESHOLD = 200

export type CompactionResult =
  | { status: 'compacted'; folded: number }
  | { status: 'nothing-to-fold' }
  | { status: 'document-missing' }

export type CompactionSweepResult = { scanned: number; compacted: number }

// Fold one document's un-folded log into its snapshot and trim the folded rows, atomically. Safe to call
// on a doc with nothing pending (returns 'nothing-to-fold') or a non-existent id ('document-missing').
export const compactDocument = (documentId: string): Promise<CompactionResult> =>
  db.transaction(async (tx) => {
    // Lock the documents row for the whole fold — this is what makes "one compactor per document" true.
    // NO KEY UPDATE (not UPDATE): it serializes folds against each other without conflicting with the FK
    // key-share lock an append takes on this row, so appends are never blocked by a fold. See the header.
    const [meta] = await tx
      .select({ snapshot: documentsTable.snapshot })
      .from(documentsTable)
      .where(eq(documentsTable.id, documentId))
      .for('no key update')
      .limit(1)
    if (meta === undefined) {
      return { status: 'document-missing' }
    }

    // The whole un-folded tail (folded rows are already deleted). Capture each seq so we delete exactly
    // what we fold — never a row that commits between this read and the delete below.
    const pending = await tx
      .select({ seq: documentUpdatesTable.seq, update: documentUpdatesTable.update })
      .from(documentUpdatesTable)
      .where(eq(documentUpdatesTable.documentId, documentId))
      .orderBy(asc(documentUpdatesTable.seq))
    if (pending.length === 0) {
      return { status: 'nothing-to-fold' }
    }

    const doc = new Y.Doc()
    try {
      if (meta.snapshot !== null) {
        Y.applyUpdate(doc, meta.snapshot)
      }
      for (const row of pending) {
        Y.applyUpdate(doc, row.update)
      }
      const foldedSnapshot = Y.encodeStateAsUpdate(doc)
      const foldedSeqs = pending.map((row) => row.seq)

      // Snapshot write and row delete are one transaction: a crash between them must never advance the
      // snapshot while leaving its folded rows in the log (they'd replay on top → double-apply), nor
      // delete rows the snapshot didn't capture (→ data loss). Atomic, so neither half can happen alone.
      await tx
        .update(documentsTable)
        .set({ snapshot: foldedSnapshot })
        .where(eq(documentsTable.id, documentId))
      await tx
        .delete(documentUpdatesTable)
        .where(
          and(
            eq(documentUpdatesTable.documentId, documentId),
            inArray(documentUpdatesTable.seq, foldedSeqs),
          ),
        )
      return { status: 'compacted', folded: foldedSeqs.length }
    } finally {
      doc.destroy()
    }
  })

// The documents whose un-folded tail has reached the threshold — the sweep's work list. document_updates
// holds only un-folded rows (folded ones are deleted), so a plain COUNT per document IS the tail length.
export const findDocumentsNeedingCompaction = async (
  threshold: number = COMPACTION_THRESHOLD,
): Promise<string[]> => {
  const pendingCount = count()
  const rows = await db
    .select({ documentId: documentUpdatesTable.documentId, pending: pendingCount })
    .from(documentUpdatesTable)
    .groupBy(documentUpdatesTable.documentId)
    .having(gte(pendingCount, threshold))
  return rows.map((row) => row.documentId)
}

// One sweep: fold every document over the threshold. Sequential by design — there is one compactor — and
// each fold is isolated so a failure on one document never aborts the rest of the sweep.
export const compactPendingDocuments = async (
  threshold: number = COMPACTION_THRESHOLD,
): Promise<CompactionSweepResult> => {
  const documentIds = await findDocumentsNeedingCompaction(threshold)
  let compacted = 0
  for (const documentId of documentIds) {
    try {
      const result = await compactDocument(documentId)
      if (result.status === 'compacted') {
        compacted += 1
      }
    } catch (error) {
      // The un-folded log is intact (the fold is atomic), so this doc is simply tried again next sweep.
      console.error(`[compaction] failed to compact ${documentId}`, error)
    }
  }
  return { scanned: documentIds.length, compacted }
}
