import { type SyntheticEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { API_forgotPassword, ApiError } from '../lib/api'

export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await API_forgotPassword({ email })
      // The backend answers identically whether or not the email has an account (no enumeration), so
      // the UI does too: always "check your email", never "no account with that email".
      setSubmitted(true)
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not send the reset link. Please try again.',
      )
    } finally {
      setPending(false)
    }
  }

  if (submitted) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-slate-600">
          If <strong>{email}</strong> has an account, we just sent it a link to reset your password.
          It expires in 1 hour.
        </p>
        <p className="mt-3 text-xs text-slate-400">
          Local dev: the message is waiting in Mailpit at{' '}
          <a className="underline" href="http://localhost:8025" target="_blank" rel="noreferrer">
            localhost:8025
          </a>
          .
        </p>
        <p className="mt-4 text-center text-sm text-slate-600">
          <Link to="/login" className="font-medium text-slate-900 underline">
            Back to log in
          </Link>
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Reset your password">
      <p className="mb-4 text-sm text-slate-600">
        Enter your email and we'll send you a link to set a new password.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        Remembered it?{' '}
        <Link to="/login" className="font-medium text-slate-900 underline">
          Log in
        </Link>
      </p>
    </AuthCard>
  )
}
