import { Worker } from 'bullmq'
import { compactPendingDocuments } from '../sync/compaction.ts'
import { COMPACTION_QUEUE_NAME } from './compaction-queue.ts'
import { queueConnectionConfig } from './connection.ts'

// Drains the compaction queue. Each job is one sweep: find the documents whose un-folded tail crossed the
// threshold and fold each. concurrency 1 keeps a single sweep running at a time, so a slow sweep never
// overlaps the next tick. (compactDocument's per-row FOR UPDATE lock is the real correctness guard; the
// concurrency cap just avoids pointless pile-up.) Runs as the standalone worker process in production
// and in-process during dev — the same module either way. The caller owns the returned Worker.
export const createCompactionWorker = (): Worker => {
  const worker = new Worker(
    COMPACTION_QUEUE_NAME,
    async () => {
      const result = await compactPendingDocuments()
      if (result.compacted > 0) {
        console.log(`[compaction] folded ${result.compacted}/${result.scanned} document(s)`)
      }
    },
    { connection: queueConnectionConfig(), concurrency: 1 },
  )
  // An unhandled 'error' event would crash the worker process; log a Redis/worker-level error and let it
  // reconnect. This is distinct from a sweep failing — a failed job rejects and BullMQ retries it.
  worker.on('error', (error) => {
    console.error('[compaction-worker] worker error', error)
  })
  return worker
}
