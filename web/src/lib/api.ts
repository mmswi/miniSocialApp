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

export const API_login = (input: {
  email: string
  password: string
}): Promise<{ user: PublicUser }> =>
  request('/auth/login', { method: 'POST', body: JSON.stringify(input) })

export const API_logout = (): Promise<null> => request('/auth/logout', { method: 'POST' })
