import { type SyntheticEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { API_resetPassword, ApiError } from '../lib/api'

export const ResetPasswordPage = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // A link with no token is malformed — don't show a form that can only fail. (Validating the token
  // itself is left to submit: it's a single-use secret, so there's no cheap "is it still valid?" check.)
  if (token === '') {
    return (
      <AuthCard title="Invalid reset link">
        <p className="text-sm text-slate-600">
          This password reset link is missing its token. Request a fresh one and try again.
        </p>
        <p className="mt-4 text-center text-sm text-slate-600">
          <Link to="/forgot-password" className="font-medium text-slate-900 underline">
            Request a new link
          </Link>
        </p>
      </AuthCard>
    )
  }

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    // Catch a typo before spending the single-use token: the confirmation never goes to the server
    // (the API only takes one password), it's purely a client-side guard against mismatched entries.
    if (password !== confirmPassword) {
      setError("Those passwords don't match.")
      return
    }
    setPending(true)
    try {
      await API_resetPassword({ token, password })
      // Reset deliberately doesn't open a session — land on login with a confirmation banner.
      navigate('/login?reset=1')
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reset your password. Please try again.',
      )
      setPending(false)
    }
  }

  return (
    <AuthCard title="Set a new password">
      <form onSubmit={onSubmit} className="space-y-3">
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Reset password'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        Need a new link?{' '}
        <Link to="/forgot-password" className="font-medium text-slate-900 underline">
          Request one
        </Link>
      </p>
    </AuthCard>
  )
}
