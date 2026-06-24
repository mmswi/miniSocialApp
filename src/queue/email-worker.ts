import { Worker } from 'bullmq'
import { type EmailMessage, sendEmail } from '../lib/email.ts'
import { queueConnectionConfig } from './connection.ts'
import { EMAIL_QUEUE_NAME } from './email-queue.ts'

// How a queued email is actually delivered. `sendEmail` throws on an SMTP failure — that throw is
// load-bearing here (see the handler), so the type stays a plain "may reject" promise.
type DeliverEmail = (message: EmailMessage) => Promise<void>

// We only read the payload off the job, so the processor is typed against just that. This keeps it
// unit-testable with a plain `{ data }` object (no need to fabricate a whole BullMQ Job) and still
// satisfies Worker's processor type, which passes a full Job that structurally fits this shape.
type EmailJob = { data: EmailMessage }

// The job processor, with delivery injected so a test can drive both outcomes without a live mail
// server. It deliberately lets a delivery error PROPAGATE: a rejected job is exactly what tells BullMQ
// to retry it with backoff. If this caught-and-logged instead, the queue would mark the job complete
// and the email would be silently lost — the precise failure this whole feature exists to prevent.
export const createEmailJobHandler =
  (deliver: DeliverEmail) =>
  async (job: EmailJob): Promise<void> => {
    await deliver(job.data)
  }

// Starts the consumer that drains the email queue, delivering each job over real SMTP. Runs as the
// standalone worker process in production and in-process during dev (see the server boot). BullMQ
// builds its own blocking connection from the config. The caller owns the returned Worker's lifecycle.
export const createEmailWorker = (): Worker<EmailMessage> => {
  const worker = new Worker<EmailMessage>(EMAIL_QUEUE_NAME, createEmailJobHandler(sendEmail), {
    connection: queueConnectionConfig(),
  })
  // An unhandled 'error' event would crash the worker process; log a Redis/worker-level error and let
  // it reconnect. This is distinct from a job failing — a failed job rejects and BullMQ retries it.
  worker.on('error', (error) => {
    console.error('[email-worker] worker error', error)
  })
  return worker
}
