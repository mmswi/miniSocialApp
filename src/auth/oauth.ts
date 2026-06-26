import { Google, decodeIdToken, generateCodeVerifier, generateState } from 'arctic'
import { z } from 'zod'
import { env } from '../lib/env.ts'
import { badRequest } from '../lib/errors.ts'

// One Google client per process. Constructing it is pure config (no network), so a module-level
// instance is fine — it stays inert until a /auth/google request actually calls it.
const google = new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI)

// openid + email give us the verified-email claim that account-linking is gated on; profile adds
// the display name and avatar.
const GOOGLE_SCOPES = ['openid', 'email', 'profile']

// What we trust from Google's id token after parsing — exactly what the linking logic needs.
export type GoogleClaims = {
  googleUserId: string
  email: string
  emailVerified: boolean
  name?: string
  avatarUrl?: string
}

// Google sends email_verified as a real JSON boolean. Parsing strictly means a surprise shape fails
// CLOSED (a 400) instead of silently coercing — we never want a malformed claim to read as "verified".
const googleIdTokenClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
})

// Builds the Google consent URL plus the two secrets the callback needs back: `state` (CSRF —
// Cross-Site Request Forgery) and `codeVerifier` (PKCE — Proof Key for Code Exchange). The caller
// stores both in short-lived cookies and redirects to `url`.
export const createGoogleAuthorization = (): { url: URL; state: string; codeVerifier: string } => {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES)
  return { url, state, codeVerifier }
}

// Exchanges the one-time `code` for tokens (Google checks PKCE against the verifier), then reads the
// identity out of the id token. The token came straight from Google's token endpoint over TLS, so we
// decode the claims rather than re-verifying a signature. Any transport failure or unexpected claim
// shape becomes a clean 400 — never a 500 leaking internals to a browser mid-redirect.
export const exchangeGoogleCode = async (
  code: string,
  codeVerifier: string,
): Promise<GoogleClaims> => {
  let rawClaims: object
  try {
    const tokens = await google.validateAuthorizationCode(code, codeVerifier)
    rawClaims = decodeIdToken(tokens.idToken())
  } catch {
    throw badRequest(
      'oauth_exchange_failed',
      'Could not complete Google sign-in. Please try again.',
    )
  }

  const parsed = googleIdTokenClaims.safeParse(rawClaims)
  if (!parsed.success) {
    throw badRequest('oauth_invalid_claims', 'Google sign-in returned an unexpected profile.')
  }

  return {
    googleUserId: parsed.data.sub,
    email: parsed.data.email.trim().toLowerCase(),
    emailVerified: parsed.data.email_verified ?? false,
    name: parsed.data.name,
    avatarUrl: parsed.data.picture,
  }
}
