import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Button } from '../components/Button'

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
          <Button
            variant="secondary"
            type="button"
            onClick={() => window.location.assign('/auth/google/link')}
          >
            Connect Google account
          </Button>
          <Button type="button" onClick={onSignOut}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  )
}
