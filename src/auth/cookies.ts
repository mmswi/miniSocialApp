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

// During a Google sign-in we hand the browser two short-lived secrets and ask for them back on the
// callback: the `state` (CSRF — proves the callback came from our redirect) and the PKCE
// `codeVerifier` (proves this client started the exchange). They live only for the round trip.
export const OAUTH_STATE_COOKIE = 'redline_oauth_state'
export const OAUTH_VERIFIER_COOKIE = 'redline_oauth_verifier'

// 10 minutes is plenty to click through Google's consent screen and come back; after that the
// handshake is stale and a fresh /auth/google should be started.
const OAUTH_HANDSHAKE_TTL_SECONDS = 60 * 10

// sameSite 'lax' is load-bearing here: the callback arrives as a top-level GET navigation from
// google.com, and 'lax' is exactly the level that still sends the cookie on that cross-site redirect.
const handshakeCookie = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: OAUTH_HANDSHAKE_TTL_SECONDS,
})

export const setOAuthHandshakeCookies = (
  reply: FastifyReply,
  state: string,
  codeVerifier: string,
): void => {
  reply.setCookie(OAUTH_STATE_COOKIE, state, handshakeCookie())
  reply.setCookie(OAUTH_VERIFIER_COOKIE, codeVerifier, handshakeCookie())
}

export const clearOAuthHandshakeCookies = (reply: FastifyReply): void => {
  reply.clearCookie(OAUTH_STATE_COOKIE, handshakeCookie())
  reply.clearCookie(OAUTH_VERIFIER_COOKIE, handshakeCookie())
}
