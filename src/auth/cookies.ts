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

// During a 2FA login the user is HALF-authenticated: the password passed, but no session exists yet.
// We carry that pending state in a short-lived httpOnly cookie holding a raw token whose hash keys a
// Redis entry (see auth/mfa.ts). It is deliberately a SEPARATE cookie from the session — getSessionUser
// must never accept it — so a half-auth token can never be mistaken for a real, fully-authed session.
export const MFA_COOKIE_NAME = 'redline_mfa'

// Same flags as the session cookie. The lifetime is the caller's `expiresAt`, set to match the Redis
// entry's TTL so the cookie and the server-side pending state lapse together.
const baseMfaCookie = (): CookieSerializeOptions => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
})

export const setMfaCookie = (reply: FastifyReply, rawToken: string, expiresAt: Date): void => {
  reply.setCookie(MFA_COOKIE_NAME, rawToken, { ...baseMfaCookie(), expires: expiresAt })
}

export const clearMfaCookie = (reply: FastifyReply): void => {
  reply.clearCookie(MFA_COOKIE_NAME, baseMfaCookie())
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

// A third handshake marker, set ONLY by the link-mode start route (/auth/google/link). The shared
// callback reads it to decide "attach Google to the signed-in user" vs "sign in". It carries no secret,
// just the mode — so it needs no integrity protection; the session cookie is what proves WHO is linking.
export const OAUTH_LINK_COOKIE = 'redline_oauth_link'

export const setOAuthLinkCookie = (reply: FastifyReply): void => {
  reply.setCookie(OAUTH_LINK_COOKIE, '1', handshakeCookie())
}

// The normal sign-in start (/auth/google) clears this, so a marker left over from an abandoned link
// flow can't make the shared callback mistake a plain sign-in for a link. Both start routes therefore
// write a DEFINITIVE mode — link sets it, sign-in clears it — and the callback never reads a stale one.
export const clearOAuthLinkCookie = (reply: FastifyReply): void => {
  reply.clearCookie(OAUTH_LINK_COOKIE, handshakeCookie())
}

export const clearOAuthHandshakeCookies = (reply: FastifyReply): void => {
  reply.clearCookie(OAUTH_STATE_COOKIE, handshakeCookie())
  reply.clearCookie(OAUTH_VERIFIER_COOKIE, handshakeCookie())
  reply.clearCookie(OAUTH_LINK_COOKIE, handshakeCookie())
}
