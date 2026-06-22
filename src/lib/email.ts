import { env } from './env.ts'

type EmailMessage = { to: string; subject: string; text: string }

// Captured in-memory under `bun test` so an end-to-end test can read back the link we "sent" — signup
// only ever emails the raw token, since the DB keeps just its hash. Empty in dev and production.
export const sentEmails: EmailMessage[] = []

// Dev transport: logs the message (link included) so you can copy the verification link straight from
// the server console. A real provider (Resend/SES/…) and a background queue get wired in here later,
// behind this same function — callers never change.
export const sendEmail = async (message: EmailMessage): Promise<void> => {
  if (env.NODE_ENV === 'test') {
    sentEmails.push(message)
    return
  }
  console.info(
    `[email] from=${env.EMAIL_FROM} to=${message.to} subject="${message.subject}"\n${message.text}`,
  )
}
