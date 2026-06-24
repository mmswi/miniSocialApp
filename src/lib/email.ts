import { type Transporter, createTransport } from 'nodemailer'
import { env } from './env.ts'

type EmailMessage = { to: string; subject: string; text: string }

// Captured in-memory under `bun test` so an end-to-end test can read back the link we "sent" — signup
// only ever emails the raw token, since the DB keeps just its hash. Empty in dev and production.
export const sentEmails: EmailMessage[] = []

// One SMTP transporter per process, cached on globalThis so dev hot-reload reuses it instead of leaking
// a connection each reload. createTransport is inert — it opens a socket only on the first sendMail —
// so the import stays side-effect-free (the server-singleton pattern, same as db/redis).
type MailerGlobal = { mailer?: Transporter }
const globalForMailer = globalThis as unknown as MailerGlobal

const mailer = (): Transporter => {
  globalForMailer.mailer ??= createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // Mailpit wants no auth; a real provider sets SMTP_USER/SMTP_PASS. Empty user → omit auth entirely.
    auth: env.SMTP_USER === '' ? undefined : { user: env.SMTP_USER, pass: env.SMTP_PASS },
  })
  return globalForMailer.mailer
}

// Sends a message over SMTP. In dev that's the local Mailpit catcher (read it at http://localhost:8025);
// in production it's a real provider. Throws on a transport failure — callers that must not fail on a
// mail hiccup (signup) catch it; a queued retry layer is the later hardening. Under test we skip SMTP
// entirely and record the message so a test can assert on it.
export const sendEmail = async (message: EmailMessage): Promise<void> => {
  if (env.NODE_ENV === 'test') {
    sentEmails.push(message)
    return
  }
  await mailer().sendMail({
    from: env.EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
  })
}
