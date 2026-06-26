import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

// The sign-in methods the API reports in `linkedProviders`. The frontend's OWN copy of the backend's
// auth_provider enum, kept deliberately separate: importing the server's AUTH_PROVIDERS from
// db/schema.ts would drag drizzle-orm into the client bundle. The CLIENT_ prefix marks these as
// independent mirrors of one wire contract — not a shared source — so a reader never assumes they
// auto-sync. Naming each value once also keeps call sites off bare 'google' strings a typo could break.
export const CLIENT_AUTH_PROVIDERS = { password: 'password', google: 'google' } as const
// A name unique to the client: distinct from the `AuthProvider` component (auth/AuthProvider.tsx) AND
// from the server's `AuthProviderId` (db/schema.ts). Nothing in web/ can auto-import the wrong one, and
// the two mirrored unions can never be mistaken for one shared type.
export type ClientAuthProviderId =
  (typeof CLIENT_AUTH_PROVIDERS)[keyof typeof CLIENT_AUTH_PROVIDERS]

// The safe user projection the backend returns (never the password hash or internal columns).
export type PublicUser = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  // Which sign-in methods are connected — lets the UI hide "Connect Google" once google is linked.
  linkedProviders: ClientAuthProviderId[]
}

// Mirrors the backend's error envelope ({ error, message }) so the UI can show a real message and
// branch on the stable code — e.g. 'rate_limited' for a 429, 'invalid_credentials' for a bad login.
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// Every call rides the httpOnly session cookie (credentials:'include') and goes through the Vite proxy
// to the API. A non-2xx becomes an ApiError carrying the backend's code+message; a 204 (logout) is null.
const request = async <Result>(path: string, init?: RequestInit): Promise<Result> => {
  const hasBody = init?.body !== undefined
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: hasBody ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      message?: string
    } | null
    throw new ApiError(
      response.status,
      body?.error ?? 'error',
      body?.message ?? 'Something went wrong. Please try again.',
    )
  }

  if (response.status === 204) {
    return null as Result
  }
  return (await response.json()) as Result
}

export const API_fetchMe = (): Promise<{ user: PublicUser }> => request('/auth/me')

export const API_signup = (input: {
  email: string
  password: string
  name?: string
}): Promise<{ message: string }> =>
  request('/auth/signup', { method: 'POST', body: JSON.stringify(input) })

// Login has two outcomes now: a session (a user comes back), or "second factor required" for a 2FA
// account — then the client runs the passkey step at /2fa. The pending-MFA cookie is set server-side,
// so the only thing the client learns here is which branch it's on.
export type LoginResult = { user: PublicUser } | { mfaRequired: true }

export const API_login = (input: { email: string; password: string }): Promise<LoginResult> =>
  request('/auth/login', { method: 'POST', body: JSON.stringify(input) })

export const API_logout = (): Promise<null> => request('/auth/logout', { method: 'POST' })

export const API_forgotPassword = (input: { email: string }): Promise<{ message: string }> =>
  request('/auth/forgot-password', { method: 'POST', body: JSON.stringify(input) })

export const API_resetPassword = (input: {
  token: string
  password: string
}): Promise<{ message: string }> =>
  request('/auth/reset-password', { method: 'POST', body: JSON.stringify(input) })

// --- two-factor (passkey) login ---
// The challenge/response handshake. The page calls options, hands the JSON to the browser's
// startAuthentication (which triggers Face ID), then posts the assertion back to verify. All three
// ride the httpOnly redline_mfa cookie set at /login — the client never handles the pending token.

export const API_2faAuthenticateOptions = (): Promise<PublicKeyCredentialRequestOptionsJSON> =>
  request('/auth/2fa/authenticate/options', { method: 'POST' })

export const API_2faAuthenticateVerify = (
  response: AuthenticationResponseJSON,
): Promise<{ user: PublicUser }> =>
  request('/auth/2fa/authenticate/verify', { method: 'POST', body: JSON.stringify({ response }) })

// The lose-your-phone path: a recovery code instead of a passkey. Returns how many codes are left.
export const API_2faRecoveryVerify = (
  code: string,
): Promise<{ user: PublicUser; recoveryCodesRemaining: number }> =>
  request('/auth/2fa/recovery/verify', { method: 'POST', body: JSON.stringify({ code }) })

// --- two-factor management (the Security page; all behind a live session) ---

// A passkey as the Security page sees it — the server's safe projection, no key material. Dates arrive
// as ISO strings over JSON.
export type Passkey = {
  id: string
  name: string | null
  backedUp: boolean | null
  createdAt: string
  lastUsedAt: string | null
}

export const API_2faRegisterOptions = (): Promise<PublicKeyCredentialCreationOptionsJSON> =>
  request('/auth/2fa/register/options', { method: 'POST' })

// On the FIRST passkey the server returns recoveryCodes — shown to the user exactly once.
export const API_2faRegisterVerify = (input: {
  response: RegistrationResponseJSON
  name?: string
}): Promise<{ credentialId: string; recoveryCodes?: string[] }> =>
  request('/auth/2fa/register/verify', { method: 'POST', body: JSON.stringify(input) })

export const API_2faListCredentials = (): Promise<{
  credentials: Passkey[]
  recoveryCodesRemaining: number
}> => request('/auth/2fa/credentials')

export const API_2faRenameCredential = (
  id: string,
  name: string,
): Promise<{ id: string; name: string }> =>
  request(`/auth/2fa/credentials/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })

export const API_2faDeleteCredential = (id: string): Promise<{ id: string; removed: true }> =>
  request(`/auth/2fa/credentials/${id}`, { method: 'DELETE' })

// Step-up: the challenge for proving a fresh passkey before disabling 2FA.
export const API_2faStepUpOptions = (): Promise<PublicKeyCredentialRequestOptionsJSON> =>
  request('/auth/2fa/stepup/options', { method: 'POST' })

// Turning 2FA off needs a fresh factor — a step-up passkey assertion or a recovery code.
export const API_2faDisable = (
  proof: { assertion: AuthenticationResponseJSON } | { recoveryCode: string },
): Promise<{ disabled: true }> =>
  request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify(proof) })

// --- documents ---

// A document as the client holds it — the server's DocumentSummary wire shape (no binary snapshot).
// Dates arrive as ISO strings over JSON. Named distinctly from the server type and the DOM's own
// `Document` so nothing in web/ can auto-import the wrong one across the boundary.
export type DocumentMeta = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export const API_listDocuments = (): Promise<{ documents: DocumentMeta[] }> => request('/documents')

// No title sends `{}`, so the server applies its default ('Untitled document').
export const API_createDocument = (
  input: { title?: string } = {},
): Promise<{
  document: DocumentMeta
}> => request('/documents', { method: 'POST', body: JSON.stringify(input) })

export const API_deleteDocument = (id: string): Promise<null> =>
  request(`/documents/${id}`, { method: 'DELETE' })
