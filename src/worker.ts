import { EMAIL_QUEUE_NAME } from './queue/email-queue.ts'
import { createEmailWorker } from './queue/email-worker.ts'

// The background worker process — the queue's consumer. In production this runs as its OWN long-lived
// container, separate from the API, so a slow mail provider can never tie up a request handler. In dev
// the API boots the same worker in-process for convenience (see server.ts), so this entrypoint is the
// production path. Add future queues' workers here as they arrive.
const startWorker = (): void => {
  const emailWorker = createEmailWorker()
  console.log(`[worker] started — draining the "${EMAIL_QUEUE_NAME}" queue`)

  // Graceful shutdown: stop taking new jobs and let in-flight deliveries finish before exiting, so a
  // deploy or restart never drops a job mid-send. The platform sends SIGTERM; SIGINT is Ctrl-C in dev.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received — closing`)
    await emailWorker.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// Only run when executed directly (`bun run src/worker.ts`), never on import — so importing anything
// from here in a test stays side-effect free.
if (import.meta.main) {
  startWorker()
}
