import { startRegistration } from '@simplewebauthn/browser'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SecurityPage } from './SecurityPage'

// The authenticator can't run in jsdom, so the browser ceremony is mocked. We check the page's
// orchestration and its show-recovery-codes-once behavior, not a real registration.
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  WebAuthnError: class WebAuthnError extends Error {},
}))

const fakeAttestation = {
  id: 'new-cred',
  rawId: 'new-cred',
  response: { clientDataJSON: '', attestationObject: '' },
  clientExtensionResults: {},
  type: 'public-key' as const,
}

const onePasskey = {
  credentials: [
    {
      id: 'cred-1',
      name: 'My iPhone',
      backedUp: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    },
  ],
  recoveryCodesRemaining: 9,
}

// Answers by URL substring so mount-load + the action + reload are all satisfied by one stub.
const fetchByUrl = (routes: Record<string, unknown>) =>
  vi.fn((url: string) => {
    const body = Object.entries(routes).find(([path]) => url.includes(path))?.[1] ?? {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  })

const renderPage = () =>
  render(
    <MemoryRouter>
      <SecurityPage />
    </MemoryRouter>,
  )

describe('SecurityPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('lists enrolled passkeys and the recovery-code count', async () => {
    vi.stubGlobal('fetch', fetchByUrl({ '/auth/2fa/credentials': onePasskey }))

    renderPage()

    expect(await screen.findByText('My iPhone')).toBeInTheDocument()
    expect(screen.getByText(/1 passkey, 9 of 10 recovery codes left/)).toBeInTheDocument()
  })

  test('enrolling reveals the recovery codes exactly once', async () => {
    const fetchSpy = fetchByUrl({
      '/auth/2fa/credentials': { credentials: [], recoveryCodesRemaining: 0 },
      '/auth/2fa/register/options': { challenge: 'abc', rp: { id: 'localhost', name: 'redline' } },
      '/auth/2fa/register/verify': {
        credentialId: 'new-cred',
        recoveryCodes: ['A7KM-9QR3-FXP2', 'B8LN-2WS4-GZ5Q'],
      },
    })
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(startRegistration).mockResolvedValue(fakeAttestation)

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }))

    // The codes from register/verify are surfaced once, with the save-them warning.
    expect(await screen.findByText('A7KM-9QR3-FXP2')).toBeInTheDocument()
    expect(screen.getByText(/only time they're shown/i)).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/auth/2fa/register/verify',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('disabling 2FA with a recovery code posts to /disable', async () => {
    const fetchSpy = fetchByUrl({
      '/auth/2fa/credentials': onePasskey,
      '/auth/2fa/disable': { disabled: true },
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderPage()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disable two-factor authentication' }),
    )
    await userEvent.type(screen.getByLabelText('…or enter a recovery code'), 'A7KM-9QR3-FXP2')
    await userEvent.click(screen.getByRole('button', { name: 'Disable with a recovery code' }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/auth/2fa/disable',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
