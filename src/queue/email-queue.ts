import { type JobsOptions, Queue } from 'bullmq'
import { type EmailMessage, sendEmail } from '../lib/email.ts'
import { env } from '../lib/env.ts'
import { queueConnectionConfig } from './connection.ts'

// One queue name, referenced by both the producer (here) and the worker. A bare 'email' string in two
// files would let a typo silently split them into two queues that never talk — so it lives once.
export const EMAIL_QUEUE_NAME = 'email'

// One job type on this queue for now; named so the producer and any future per-type handler agree.
export const EMAIL_JOB_NAME = 'send'

// Delivery policy for a queued email: retry a flaky SMTP send a few times with widening gaps before
// giving up, so a transient provider hiccup never loses a verification link. Succeeded jobs are dropped
// to keep Redis lean; FAILED jobs are KEPT (removeOnFail: false) so an exhausted email is inspectable —
// a dead letter you can read, not a silent loss.
const EMAIL_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
}

// One Queue (the producer handle) per process, cached on globalThis so dev hot-reload and repeated
// imports reuse it instead of leaking a Redis connection each time — the same singleton pattern as
// db/redis. Built lazily inside the getter so the import stays cheap and nothing connects until the
// first enqueue.
type EmailQueueGlobal = { emailQueue?: Queue<EmailMessage> }
const globalForEmailQueue = globalThis as unknown as EmailQueueGlobal

// An unhandled 'error' event on a BullMQ Queue throws (EventEmitter semantics), so a dropped Redis
// connection would crash the producer process — log it and let ioredis reconnect instead.
const createEmailQueue = (): Queue<EmailMessage> => {
  const queue = new Queue<EmailMessage>(EMAIL_QUEUE_NAME, {
    connection: queueConnectionConfig(),
    defaultJobOptions: EMAIL_JOB_OPTIONS,
  })
  queue.on('error', (error) => {
    console.error('[email-queue] queue error', error)
  })
  return queue
}

const emailQueue = (): Queue<EmailMessage> => {
  globalForEmailQueue.emailQueue ??= createEmailQueue()
  return globalForEmailQueue.emailQueue
}

// Hands an email to the durable queue; the worker delivers it with retries. This replaces a direct,
// flaky SMTP send at the call site — enqueueing touches only Redis, so the caller (signup) no longer
// waits on, or fails with, the mail provider. Under `bun test` there is no running worker, so we
// deliver inline instead: that preserves the in-memory `sentEmails` contract the auth E2E reads the
// verification link out of, while every other environment goes through the queue.
export const enqueueEmail = async (message: EmailMessage): Promise<void> => {
  if (env.NODE_ENV === 'test') {
    await sendEmail(message)
    return
  }
  await emailQueue().add(EMAIL_JOB_NAME, message)
}
