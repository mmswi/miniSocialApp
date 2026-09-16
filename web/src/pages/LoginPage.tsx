import { type SyntheticEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { API_login, ApiError } from '../lib/api'
import { INVITE_TOKEN_PARAM, withInviteToken } from '../lib/invite-link'

export const LoginPage = () => {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [searchParams] = useSearchParams()
  const justVerified = searchParams.get('verified') === '1'
  const justReset = searchParams.get('reset') === '1'
  // Present when the user arrived mid-invite (from /invite → here). We carry it through the 2FA step and,
  // on success, return to /invite so they land back on the accept screen instead of the dashboard.
  const inviteToken = searchParams.get(INVITE_TOKEN_PARAM)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const result = await API_login({ email, password })
      // A 2FA account needs the second factor before any session exists — head to /2fa, where the
      // pending-MFA cookie (already set) gates the passkey step. Carry the invite token so it survives
      // the 2FA hop too.
      if ('mfaRequired' in result) {
        navigate(withInviteToken('/2fa', inviteToken))
        return
      }
      // Re-pull /auth/me so the app knows we're authenticated, then land — back on the invite if we came
      // from one, otherwise on the dashboard.
      await refresh()
      navigate(inviteToken !== null ? withInviteToken('/invite', inviteToken) : '/')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not log in. Please try again.')
      setPending(false)
    }
  }

  return (
    <AuthCard title="Log in to redline">
      {justVerified ? (
        <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Email verified. Log in to continue.
        </p>
      ) : null}
      {justReset ? (
        <p className="mb-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Password updated. Log in with your new password.
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-3">
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="text-right">
          <Link to="/forgot-password" className="text-sm text-slate-500 underline">
            Forgot password?
          </Link>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
      <div className="my-4 text-center text-xs text-slate-400">or</div>
      <Button
        variant="secondary"
        type="button"
        onClick={() => window.location.assign('/auth/google')}
      >
        Continue with Google
      </Button>
      <p className="mt-4 text-center text-sm text-slate-600">
        No account?{' '}
        <Link
          to={withInviteToken('/signup', inviteToken)}
          className="font-medium text-slate-900 underline"
        >
          Sign up
        </Link>
      </p>
    </AuthCard>
  )
}
