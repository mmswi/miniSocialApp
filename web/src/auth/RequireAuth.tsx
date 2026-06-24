import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

type Props = { children: ReactNode }

// Gates a route on an authenticated session. While the first /auth/me is in flight we render nothing
// (avoids a flash of the login redirect). Once resolved, an anonymous user is sent to /login — and we
// carry the current query string along, so a post-verify redirect like /?verified=1 keeps its banner.
export const RequireAuth = ({ children }: Props) => {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return null
  }
  if (status === 'anonymous') {
    return <Navigate to={`/login${location.search}`} replace />
  }
  return children
}
