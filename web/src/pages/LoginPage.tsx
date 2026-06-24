import { type SyntheticEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { API_login, ApiError } from '../lib/api'

export const LoginPage = () => {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [searchParams] = useSearchParams()
  const justVerified = searchParams.get('verified') === '1'
  const justReset = searchParams.get('reset') === '1'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await API_login({ email, password })
      // Re-pull /auth/me so the app knows we're authenticated, then land on the dashboard.
      await refresh()
      navigate('/')
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
        <Link to="/signup" className="font-medium text-slate-900 underline">
          Sign up
        </Link>
      </p>
    </AuthCard>
  )
}
