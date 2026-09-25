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

// Mirror of the server's DOCUMENT_ACCESS_LEVELS (documents/access.ts), kept separate from server code.
export const CLIENT_DOCUMENT_ACCESS_LEVELS = {
  read: 'read',
  write: 'write',
  delete: 'delete',
} as const
export type ClientDocumentAccessLevel =
  (typeof CLIENT_DOCUMENT_ACCESS_LEVELS)[keyof typeof CLIENT_DOCUMENT_ACCESS_LEVELS]

// The caller's access to a document, as GET /documents/:id reports it. Mirrors the server's DocumentAccess.
export const CLIENT_DOCUMENT_ACCESS_OWNER = 'owner'
export type ClientDocumentAccess = typeof CLIENT_DOCUMENT_ACCESS_OWNER | ClientDocumentAccessLevel

// Whether an access permits editing — owner or write/delete; read is view-only. Mirrors the server's
// canWriteDocument, so the editor goes read-only in exactly the cases the server would drop the write.
export const canEditWithAccess = (access: ClientDocumentAccess): boolean =>
  access === CLIENT_DOCUMENT_ACCESS_OWNER ||
  access === CLIENT_DOCUMENT_ACCESS_LEVELS.write ||
  access === CLIENT_DOCUMENT_ACCESS_LEVELS.delete

// One document's metadata plus the caller's own access to it (for the editor header + read-only gating). A
// 404 (unreachable / unknown) surfaces as an ApiError with status 404 — the editor page shows a not-found
// state rather than opening a blank doc.
export const API_getDocument = (
  id: string,
): Promise<{ document: DocumentMeta; access: ClientDocumentAccess }> => request(`/documents/${id}`)

// No title sends `{}`, so the server applies its default ('Untitled document').
export const API_createDocument = (
  input: { title?: string } = {},
): Promise<{
  document: DocumentMeta
}> => request('/documents', { method: 'POST', body: JSON.stringify(input) })

// Rename. The server trims and rejects an empty title (400 → ApiError), so the caller should send a
// non-empty title; it returns the updated metadata so the UI can reflect the canonical (trimmed) name.
export const API_renameDocument = (
  id: string,
  title: string,
): Promise<{ document: DocumentMeta }> =>
  request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })

export const API_deleteDocument = (id: string): Promise<null> =>
  request(`/documents/${id}`, { method: 'DELETE' })

// Mirrors the server's DocumentTeamListItem.
export type DocumentTeamShare = {
  id: string
  name: string
}

// The teams a document is shared into. Owner-only (a non-owner gets 403 → ApiError); the dashboard lists
// only owned documents, so the Share control is only ever reached for a document the caller owns.
export const API_getDocumentTeams = (id: string): Promise<{ teams: DocumentTeamShare[] }> =>
  request(`/documents/${id}/teams`)

// Share a document into a team. Member+ on the team AND you own the document; a re-share is a 409 (already
// shared) → ApiError. Returns the shared document's metadata.
export const API_assignDocumentToTeam = (
  teamId: string,
  documentId: string,
): Promise<{ document: DocumentMeta }> =>
  request(`/teams/${teamId}/documents`, { method: 'POST', body: JSON.stringify({ documentId }) })

// Unshare a document from a team. Allowed for the document owner (always the case from the dashboard).
export const API_unassignDocumentFromTeam = (teamId: string, documentId: string): Promise<null> =>
  request(`/teams/${teamId}/documents/${documentId}`, { method: 'DELETE' })

// --- teams ---

// Mirror of the server's TEAM_ROLES (db/schema.ts), kept separate so drizzle-orm stays out of the bundle.
export const CLIENT_TEAM_ROLES = {
  superadmin: 'superadmin',
  admin: 'admin',
  member: 'member',
  viewer: 'viewer',
} as const
export type ClientTeamRole = (typeof CLIENT_TEAM_ROLES)[keyof typeof CLIENT_TEAM_ROLES]

// A team as the client holds it — the server's TeamSummary wire shape (no created_by_id). Dates arrive
// as ISO strings over JSON. Named distinctly from the server types (TeamSummary/TeamWithRole) so nothing
// in web/ can auto-import the wrong one across the boundary — same reason as DocumentMeta.
export type TeamMeta = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

// A team in the list: the summary plus THIS user's role in it (the server joins the role in per caller).
export type TeamListItem = TeamMeta & { role: ClientTeamRole }

export const API_listTeams = (): Promise<{ teams: TeamListItem[] }> => request('/teams')

// The caller becomes the team's superadmin.
export const API_createTeam = (input: { name: string }): Promise<{ team: TeamMeta }> =>
  request('/teams', { method: 'POST', body: JSON.stringify(input) })

// One team the caller is a member of, plus their own role in it — what the team page's header shows. A
// non-member (or unknown id) is a 404 → ApiError, which the page renders as a not-found state.
export const API_getTeam = (teamId: string): Promise<{ team: TeamMeta; role: ClientTeamRole }> =>
  request(`/teams/${teamId}`)

// A document shared into a team, as the team page lists it: the metadata plus who owns it (a team holds
// documents from several members, so "shared by Ana" needs a name). ownerName is nullable — the client
// falls back to a placeholder in that case.
export type TeamDocumentListItem = DocumentMeta & { ownerName: string | null }

// The documents shared into a team — member+ only (a non-member gets a 404 → ApiError).
export const API_listTeamDocuments = (
  teamId: string,
): Promise<{ documents: TeamDocumentListItem[] }> => request(`/teams/${teamId}/documents`)

// A team member as the team page's roster shows them. name is nullable (falls back to email); email is
// shown because team members collaborate. Mirrors the server's TeamMemberSummary.
export type TeamMemberListItem = {
  userId: string
  name: string | null
  email: string
  role: ClientTeamRole
}

// The team's members — member+ only (a non-member gets a 404 → ApiError).
export const API_listTeamMembers = (teamId: string): Promise<{ members: TeamMemberListItem[] }> =>
  request(`/teams/${teamId}/members`)

// --- team invites ---

// Mirror of the server's createInviteBody roles.
export type ClientInvitableRole =
  | typeof CLIENT_TEAM_ROLES.admin
  | typeof CLIENT_TEAM_ROLES.member
  | typeof CLIENT_TEAM_ROLES.viewer

// What the server returns for a freshly issued invite. The raw token is never in it — it lives only in
// the recipient's email — so the UI can confirm "sent to X" but can never leak a joinable link.
export type CreatedInvite = {
  email: string
  role: ClientInvitableRole
  expiresAt: string
}

// Issue an invite: the server emails the recipient a single-use link. Admin+ on the team; conferring
// admin additionally needs owner — both enforced server-side, surfacing as an ApiError 403 whose message
// the form shows verbatim. The echoed email is the normalized (lowercased) address the server stored.
export const API_createInvite = (
  teamId: string,
  input: { email: string; role: ClientInvitableRole },
): Promise<{ invite: CreatedInvite }> =>
  request(`/teams/${teamId}/invites`, { method: 'POST', body: JSON.stringify(input) })

// The public preview of an invite (no session needed) — what the /invite page shows a visitor before
// sign-in. Mirrors the server's TeamInvitePreview wire shape. An invalid or expired token surfaces as an
// ApiError (code 'invalid_invite' / 'invite_expired'), which the page renders as a dead-link state.
export type InvitePreview = {
  teamId: string
  teamName: string
  email: string
  role: ClientTeamRole
}

// Public: the token in the query string is the capability, so this rides no session. URL-encoded because
// the raw token is a base64url string going into a query param.
export const API_previewInvite = (token: string): Promise<{ invite: InvitePreview }> =>
  request(`/teams/invites/preview?token=${encodeURIComponent(token)}`)

// Accept an invite as the signed-in user. Rides the httpOnly session cookie; the server matches the
// caller's email to the invite (a mismatch is an ApiError 403; a used/expired token a 400). Returns the
// team just joined, so the caller can route onward.
export const API_acceptInvite = (
  token: string,
): Promise<{ team: { teamId: string; teamName: string } }> =>
  request('/teams/invites/accept', { method: 'POST', body: JSON.stringify({ token }) })
