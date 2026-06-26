import { describe, expect, test } from 'bun:test'
import { sentEmails } from '../lib/email.ts'
import { enqueueEmail } from './email-queue.ts'

// Under `bun test` (NODE_ENV=test) there is no running worker, so enqueueEmail must deliver inline
// rather than hit Redis — that inline path is what lets the auth E2E read the verification link back
// out of the in-memory sentEmails. This pins that contract so a future refactor can't quietly route
// the test suite through a queue no test drains (which would hang or drop the link).
describe('enqueueEmail under test', () => {
  test('delivers inline so the in-memory sentEmails captures it', async () => {
    const message = { to: 'queued@b.c', subject: 'subject', text: 'body' }
    const before = sentEmails.length

    await enqueueEmail(message)

    expect(sentEmails.slice(before)).toEqual([message])
  })
})
