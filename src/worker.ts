import { COMPACTION_QUEUE_NAME, scheduleCompactionSweep } from './queue/compaction-queue.ts'
import { createCompactionWorker } from './queue/compaction-worker.ts'
import { EMAIL_QUEUE_NAME } from './queue/email-queue.ts'
import { createEmailWorker } from './queue/email-worker.ts'

// The background worker process — the queues' consumer. In production this runs as its OWN long-lived
// container, separate from the API, so a slow mail provider or a heavy compaction sweep can never tie up
// a request handler. In dev the API boots the same workers in-process for convenience (see server.ts),
// so this entrypoint is the production path. Add future queues' workers here as they arrive.
const startWorker = async (): Promise<void> => {
  const emailWorker = createEmailWorker()
  const compactionWorker = createCompactionWorker()
  // Register the repeatable compaction sweep. Idempotent, so booting again never stacks a second one.
  await scheduleCompactionSweep()
  console.log(`[worker] started — draining "${EMAIL_QUEUE_NAME}" and "${COMPACTION_QUEUE_NAME}"`)

  // Graceful shutdown: stop taking new jobs and let in-flight work finish before exiting, so a deploy or
  // restart never drops a job mid-run. The platform sends SIGTERM; SIGINT is Ctrl-C in dev.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received — closing`)
    await emailWorker.close()
    await compactionWorker.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// Only run when executed directly (`bun run src/worker.ts`), never on import — so importing anything
// from here in a test stays side-effect free.
if (import.meta.main) {
  void startWorker()
}
