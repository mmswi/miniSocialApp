import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyReply } from 'fastify'
import { env } from '../lib/env.ts'

// Deliberately generic — the cookie name should not advertise the framework or the library.
export const SESSION_COOKIE_NAME = 'redline_session'

// One source of truth for the cookie's security flags:
//   httpOnly  — JavaScript can't read it, so an XSS bug can't exfiltrate the session token.
//   secure    — https-only, but only in production so the cookie still rides over http in local dev.
//   sameSite  — 'lax' keeps the cookie off cross-site POSTs (CSRF) while allowing normal navigation.
const baseSessionCookie = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
})

// Writes the RAW session token into an httpOnly cookie that expires exactly when the session does.
export const setSessionCookie = (reply: FastifyReply, rawToken: string, expiresAt: Date): void => {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, { ...baseSessionCookie(), expires: expiresAt })
}

// Clears the cookie on logout. The flags must match the ones used to set it, or the browser ignores
// the clear and keeps the cookie around.
export const clearSessionCookie = (reply: FastifyReply): void => {
  reply.clearCookie(SESSION_COOKIE_NAME, baseSessionCookie())
}
