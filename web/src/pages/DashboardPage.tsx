import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Button } from '../components/Button'
import { CLIENT_AUTH_PROVIDERS } from '../lib/api'

export const DashboardPage = () => {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const justLinkedGoogle = searchParams.get('linked') === 'google'

  const onSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  // RequireAuth only renders this when authenticated, so user is non-null; this guard is for types.
  if (user === null) {
    return null
  }

  // Hide "Connect Google" once it's linked: a user who signed in with Google already has it, and
  // re-linking the same identity is a confusing no-op (it returns success but changes nothing).
  const isGoogleLinked = user.linkedProviders.includes(CLIENT_AUTH_PROVIDERS.google)

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Signed in</h1>
        {justLinkedGoogle ? (
          <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            Google account linked.
          </p>
        ) : null}
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Email</dt>
            <dd className="font-medium">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Name</dt>
            <dd className="font-medium">{user.name ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email verified</dt>
            <dd className="font-medium">
              {user.emailVerified ? (
                <span className="text-green-700">yes</span>
              ) : (
                <span className="text-amber-600">no — check your inbox</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-6 space-y-2">
          {isGoogleLinked ? (
            <div className="flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-600">
              <span className="text-green-700">✓</span> Google account connected
            </div>
          ) : (
            <Button
              variant="secondary"
              type="button"
              onClick={() => window.location.assign('/auth/google/link')}
            >
              Connect Google account
            </Button>
          )}
          <Link
            to="/security"
            className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-center text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50"
          >
            Two-factor authentication
          </Link>
          <Button type="button" onClick={onSignOut}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  )
}
