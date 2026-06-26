import { WebAuthnError, startAuthentication } from '@simplewebauthn/browser'
import { type SyntheticEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import {
  API_2faAuthenticateOptions,
  API_2faAuthenticateVerify,
  API_2faRecoveryVerify,
  ApiError,
} from '../lib/api'

// Reached after a 2FA user's password passes (LoginPage routes here on { mfaRequired: true }). The
// pending-MFA cookie is already set, so this page only has to prove the second factor — a passkey, or
// a recovery code — and then re-pull /auth/me to land on the app.
export const TwoFactorPage = () => {
  const navigate = useNavigate()
  const { refresh } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [useRecovery, setUseRecovery] = useState(false)
  const [recoveryCode, setRecoveryCode] = useState('')

  // Either factor sets the session cookie on success — re-pull /auth/me, then go to the dashboard.
  const finishLogin = async () => {
    await refresh()
    navigate('/')
  }

  // One human message from two failure families: the API's own message for a server-side reason
  // (expired pending login, rejected assertion), or a friendly nudge when the passkey prompt itself
  // failed or was dismissed.
  const toMessage = (caught: unknown): string => {
    if (caught instanceof ApiError) {
      return caught.message
    }
    if (caught instanceof WebAuthnError) {
      return "Couldn't read your passkey. Try again, or use a recovery code."
    }
    return 'Something went wrong. Please try again.'
  }

  const verifyWithPasskey = async () => {
    setError(null)
    setPending(true)
    try {
      const options = await API_2faAuthenticateOptions()
      // Triggers Face ID / Touch ID / the security key; signs the server's challenge.
      const assertion = await startAuthentication({ optionsJSON: options })
      await API_2faAuthenticateVerify(assertion)
      await finishLogin()
    } catch (caught) {
      setError(toMessage(caught))
      setPending(false)
    }
  }

  const verifyWithRecoveryCode = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await API_2faRecoveryVerify(recoveryCode)
      await finishLogin()
    } catch (caught) {
      setError(toMessage(caught))
      setPending(false)
    }
  }

  return (
    <AuthCard title="Confirm it's you">
      {useRecovery ? (
        <>
          <p className="mb-4 text-sm text-slate-600">
            Enter one of the recovery codes you saved when you turned on two-factor authentication.
          </p>
          <form onSubmit={verifyWithRecoveryCode} className="space-y-3">
            <TextField
              label="Recovery code"
              autoComplete="one-time-code"
              required
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
            />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Checking…' : 'Use recovery code'}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-slate-500 underline"
            onClick={() => {
              setUseRecovery(false)
              setError(null)
            }}
          >
            Use your passkey instead
          </button>
        </>
      ) : (
        <>
          <p className="mb-4 text-sm text-slate-600">
            Your account is protected with a passkey. Confirm with Face ID, Touch ID, or your
            security key to finish signing in.
          </p>
          {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
          <Button type="button" disabled={pending} onClick={verifyWithPasskey}>
            {pending ? 'Waiting for your passkey…' : 'Verify with passkey'}
          </Button>
          <button
            type="button"
            className="mt-4 w-full text-center text-sm text-slate-500 underline"
            onClick={() => {
              setUseRecovery(true)
              setError(null)
            }}
          >
            Use a recovery code instead
          </button>
        </>
      )}
      <p className="mt-4 text-center text-sm text-slate-600">
        <Link to="/login" className="font-medium text-slate-900 underline">
          Back to log in
        </Link>
      </p>
    </AuthCard>
  )
}
