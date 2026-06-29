import { Queue } from 'bullmq'
import { queueConnectionConfig } from './connection.ts'

// One queue name, referenced by both the scheduler (here) and the worker. A bare 'compaction' string in
// two files would let a typo split them into two queues that never talk — so it lives once.
export const COMPACTION_QUEUE_NAME = 'compaction'

// The repeatable job's name AND its scheduler id. upsertJobScheduler dedupes by this id, so re-running
// it on every boot keeps exactly one schedule instead of stacking a new one per restart.
export const COMPACTION_SWEEP_JOB_NAME = 'sweep'

// How often the sweep fires. Compaction is an optimization, not durability (the append log is already
// durable), so this cadence only bounds how large the replay-on-load tail can grow — never correctness.
const COMPACTION_SWEEP_EVERY_MS = 60_000

// One Queue (the scheduler handle) per process, cached on globalThis so dev hot-reload and repeated
// imports reuse it instead of leaking a Redis connection — the same singleton pattern as the email
// queue and db/redis. Built lazily so the import stays cheap and nothing connects until first use.
type CompactionQueueGlobal = { compactionQueue?: Queue }
const globalForCompactionQueue = globalThis as unknown as CompactionQueueGlobal

const createCompactionQueue = (): Queue => {
  const queue = new Queue(COMPACTION_QUEUE_NAME, { connection: queueConnectionConfig() })
  // An unhandled 'error' event on a BullMQ Queue throws, so a dropped Redis connection would crash the
  // process — log it and let ioredis reconnect instead.
  queue.on('error', (error) => {
    console.error('[compaction-queue] queue error', error)
  })
  return queue
}

const compactionQueue = (): Queue => {
  globalForCompactionQueue.compactionQueue ??= createCompactionQueue()
  return globalForCompactionQueue.compactionQueue
}

// Register the repeatable sweep. Idempotent (upsert by scheduler id), so it's safe to call on every
// worker boot — there is always exactly one schedule. Succeeded sweeps are dropped to keep Redis lean.
export const scheduleCompactionSweep = async (): Promise<void> => {
  await compactionQueue().upsertJobScheduler(
    COMPACTION_SWEEP_JOB_NAME,
    { every: COMPACTION_SWEEP_EVERY_MS },
    { name: COMPACTION_SWEEP_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: 100 } },
  )
}
