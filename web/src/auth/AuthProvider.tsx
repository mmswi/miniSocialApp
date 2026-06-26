import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'
import { API_fetchMe, API_logout, type PublicUser } from '../lib/api'

// The session cookie is httpOnly, so JS can't read "am I logged in?" — the server is the source of
// truth. This provider asks GET /auth/me once on load and exposes the answer as auth state. `refresh`
// is what a successful login calls to re-pull /auth/me; `signOut` clears the session and the state.
//
//   'loading'        first /auth/me in flight (don't redirect yet — avoids a login flash)
//   'authenticated'  /auth/me returned a user
//   'anonymous'      /auth/me returned 401
type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

type AuthState = {
  user: PublicUser | null
  status: AuthStatus
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

type Props = { children: ReactNode }

const AuthContext = createContext<AuthState | null>(null)

export const AuthProvider = ({ children }: Props) => {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await API_fetchMe()
      setUser(me)
      setStatus('authenticated')
    } catch {
      // Any failure (401 or network) means "treat as logged out" — the protected routes handle it.
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const signOut = useCallback(async () => {
    await API_logout()
    setUser(null)
    setStatus('anonymous')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return <AuthContext value={{ user, status, refresh, signOut }}>{children}</AuthContext>
}

export const useAuth = (): AuthState => {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
