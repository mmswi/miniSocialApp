import { describe, expect, test } from 'bun:test'
import type { EmailMessage } from '../lib/email.ts'
import { createEmailJobHandler } from './email-worker.ts'

const message: EmailMessage = { to: 'a@b.c', subject: 'hi', text: 'open this link' }

describe('email job handler', () => {
  test('delivers the job payload to the mailer', async () => {
    const delivered: EmailMessage[] = []
    const handle = createEmailJobHandler(async (sent) => {
      delivered.push(sent)
    })

    await handle({ data: message })

    expect(delivered).toEqual([message])
  })

  // The load-bearing case. A failed delivery MUST reject so BullMQ retries it with backoff; if the
  // handler ever swallowed the error, the job would be marked complete and the email silently lost —
  // exactly the failure this queue exists to prevent. This pins the contract independent of BullMQ.
  test('propagates a delivery failure so the job is retried, never silently dropped', async () => {
    const handle = createEmailJobHandler(async () => {
      throw new Error('smtp down')
    })

    await expect(handle({ data: message })).rejects.toThrow('smtp down')
  })
})
