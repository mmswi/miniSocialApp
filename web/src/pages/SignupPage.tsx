import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import { API_signup, ApiError } from '../lib/api'

export const SignupPage = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const trimmedName = name.trim()
      await API_signup({ email, password, name: trimmedName === '' ? undefined : trimmedName })
      // The backend answers the same whether the email is new or taken (no enumeration), so the UI
      // does too: always show "check your email", never "that email is taken".
      setSubmitted(true)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign up. Please try again.')
    } finally {
      setPending(false)
    }
  }

  if (submitted) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-slate-600">
          If <strong>{email}</strong> can be registered, we just sent it a verification link. Open
          it to finish signing up, then log in.
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
    <AuthCard title="Create your redline account">
      <form onSubmit={onSubmit} className="space-y-3">
        <TextField
          label="Name (optional)"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
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
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Sign up'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-slate-900 underline">
          Log in
        </Link>
      </p>
    </AuthCard>
  )
}
