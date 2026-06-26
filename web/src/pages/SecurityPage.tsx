import { WebAuthnError, startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../components/Button'
import { TextField } from '../components/TextField'
import {
  API_2faDeleteCredential,
  API_2faDisable,
  API_2faListCredentials,
  API_2faRegisterOptions,
  API_2faRegisterVerify,
  API_2faRenameCredential,
  API_2faStepUpOptions,
  ApiError,
  type Passkey,
} from '../lib/api'

const toMessage = (caught: unknown): string => {
  if (caught instanceof ApiError) {
    return caught.message
  }
  if (caught instanceof WebAuthnError) {
    return "Couldn't read your passkey. Please try again."
  }
  return 'Something went wrong. Please try again.'
}

const formatDate = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleDateString()

export const SecurityPage = () => {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [codesRemaining, setCodesRemaining] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The freshly minted recovery codes, shown ONCE right after the first enrollment, then dismissed.
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [disabling, setDisabling] = useState(false)
  const [recoveryInput, setRecoveryInput] = useState('')

  const load = useCallback(async () => {
    try {
      const { credentials, recoveryCodesRemaining } = await API_2faListCredentials()
      setPasskeys(credentials)
      setCodesRemaining(recoveryCodesRemaining)
    } catch (caught) {
      setError(toMessage(caught))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Every action shares the same busy + error envelope, so one in-flight call disables the others and
  // any failure surfaces in one place.
  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (caught) {
      setError(toMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const addPasskey = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    return run(async () => {
      const options = await API_2faRegisterOptions()
      const response = await startRegistration({ optionsJSON: options }) // Face ID / Touch ID
      const trimmed = deviceName.trim()
      const result = await API_2faRegisterVerify({
        response,
        name: trimmed === '' ? undefined : trimmed,
      })
      setDeviceName('')
      // Only the first passkey returns codes — show them once; the user must save them now.
      if (result.recoveryCodes !== undefined) {
        setNewCodes(result.recoveryCodes)
      }
      await load()
    })
  }

  const removePasskey = (id: string) =>
    run(async () => {
      await API_2faDeleteCredential(id)
      await load()
    })

  const submitRename = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const id = renamingId
    if (id === null) {
      return undefined
    }
    return run(async () => {
      await API_2faRenameCredential(id, renameValue.trim())
      setRenamingId(null)
      await load()
    })
  }

  const disableWithPasskey = () =>
    run(async () => {
      const options = await API_2faStepUpOptions()
      const assertion = await startAuthentication({ optionsJSON: options })
      await API_2faDisable({ assertion })
      setDisabling(false)
      await load()
    })

  const disableWithRecovery = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    return run(async () => {
      await API_2faDisable({ recoveryCode: recoveryInput.trim() })
      setRecoveryInput('')
      setDisabling(false)
      await load()
    })
  }

  const hasPasskeys = passkeys !== null && passkeys.length > 0

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Two-factor authentication</h1>
          <Link to="/" className="text-sm text-slate-500 underline">
            Back
          </Link>
        </div>

        {error ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}

        {newCodes !== null ? (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-medium text-amber-900">
              Save your recovery codes. This is the only time they're shown.
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Each works once if you lose your device. Store them like passwords.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-slate-800">
              {newCodes.map((code) => (
                <li key={code} className="rounded bg-white px-2 py-1 text-center">
                  {code}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-3 w-full text-center text-sm font-medium text-amber-900 underline"
              onClick={() => setNewCodes(null)}
            >
              I've saved them
            </button>
          </div>
        ) : null}

        <p className="mt-4 text-sm text-slate-600">
          {passkeys === null
            ? 'Loading…'
            : hasPasskeys
              ? `On — ${passkeys.length} passkey${passkeys.length === 1 ? '' : 's'}, ${codesRemaining} of 10 recovery codes left.`
              : 'Off. Add a passkey to require a second step at login.'}
        </p>

        {hasPasskeys ? (
          <ul className="mt-4 divide-y divide-slate-100">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="py-3">
                {renamingId === passkey.id ? (
                  <form onSubmit={submitRename} className="flex items-end gap-2">
                    <div className="flex-1">
                      <TextField
                        label="Rename passkey"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                      />
                    </div>
                    <Button type="submit" disabled={busy} className="w-auto">
                      Save
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{passkey.name ?? 'Unnamed passkey'}</p>
                      <p className="text-xs text-slate-500">
                        Added {formatDate(passkey.createdAt)} · last used{' '}
                        {formatDate(passkey.lastUsedAt)}
                        {passkey.backedUp ? ' · synced' : ''}
                      </p>
                    </div>
                    <div className="flex gap-3 text-sm">
                      <button
                        type="button"
                        className="text-slate-500 underline"
                        onClick={() => {
                          setRenamingId(passkey.id)
                          setRenameValue(passkey.name ?? '')
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="text-red-600 underline disabled:opacity-50"
                        disabled={busy}
                        onClick={() => removePasskey(passkey.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={addPasskey} className="mt-6 space-y-3 border-t border-slate-100 pt-6">
          <TextField
            label="Name this device (optional)"
            placeholder="e.g. iPhone 15"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Waiting…' : hasPasskeys ? 'Add another passkey' : 'Add a passkey'}
          </Button>
        </form>

        {hasPasskeys ? (
          <div className="mt-6 border-t border-slate-100 pt-6">
            {disabling ? (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  Confirm it's you to turn off two-factor authentication. This removes all your
                  passkeys and recovery codes.
                </p>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={busy}
                  onClick={disableWithPasskey}
                >
                  Confirm with a passkey
                </Button>
                <form onSubmit={disableWithRecovery} className="space-y-2">
                  <TextField
                    label="…or enter a recovery code"
                    autoComplete="one-time-code"
                    value={recoveryInput}
                    onChange={(event) => setRecoveryInput(event.target.value)}
                  />
                  <Button variant="secondary" type="submit" disabled={busy}>
                    Disable with a recovery code
                  </Button>
                </form>
                <button
                  type="button"
                  className="w-full text-center text-sm text-slate-500 underline"
                  onClick={() => setDisabling(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="text-sm text-red-600 underline"
                onClick={() => {
                  setDisabling(true)
                  setError(null)
                }}
              >
                Disable two-factor authentication
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
