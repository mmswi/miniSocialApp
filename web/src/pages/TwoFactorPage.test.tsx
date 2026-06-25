import { startAuthentication } from '@simplewebauthn/browser'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { TwoFactorPage } from './TwoFactorPage'

// jsdom can't drive a real authenticator, so the browser handshake is mocked: startAuthentication
// resolves a canned assertion (or rejects). What we verify is the page's orchestration — call options,
// hand the result to the browser, post the assertion to verify — and its error handling. WebAuthnError
// is kept in the mock because the page imports it for an instanceof check.
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  WebAuthnError: class WebAuthnError extends Error {},
}))

const fakeUser = {
  id: 'user-1',
  email: 'mara@example.test',
  emailVerified: true,
  name: null,
  linkedProviders: [],
}

const fakeAssertion = {
  id: 'cred',
  rawId: 'cred',
  response: { clientDataJSON: '', authenticatorData: '', signature: '' },
  clientExtensionResults: {},
  type: 'public-key' as const,
}

// A fetch stub that answers by URL substring, so a single render satisfies the AuthProvider's mount
// /auth/me plus the page's options → verify → /auth/me. Unmatched URLs get an empty 200.
const fetchByUrl = (routes: Record<string, unknown>) =>
  vi.fn((url: string) => {
    const body = Object.entries(routes).find(([path]) => url.includes(path))?.[1] ?? {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  })

// The page calls useAuth(), so it needs a provider around it.
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/2fa']}>
      <AuthProvider>
        <TwoFactorPage />
      </AuthProvider>
    </MemoryRouter>,
  )

describe('TwoFactorPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('offers a passkey prompt and a recovery-code fallback', () => {
    vi.stubGlobal('fetch', fetchByUrl({ '/auth/me': { user: fakeUser } }))
    renderPage()
    expect(screen.getByRole('button', { name: 'Verify with passkey' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use a recovery code instead' })).toBeInTheDocument()
  })

  test('passkey verify runs options → startAuthentication → verify', async () => {
    const fetchSpy = fetchByUrl({
      '/auth/2fa/authenticate/options': { challenge: 'abc', rpId: 'localhost' },
      '/auth/2fa/authenticate/verify': { user: fakeUser },
      '/auth/me': { user: fakeUser },
    })
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(startAuthentication).mockResolvedValue(fakeAssertion)

    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Verify with passkey' }))

    await waitFor(() => {
      expect(startAuthentication).toHaveBeenCalled()
      expect(fetchSpy).toHaveBeenCalledWith(
        '/auth/2fa/authenticate/verify',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  test('a recovery code posts to recovery/verify', async () => {
    const fetchSpy = fetchByUrl({
      '/auth/2fa/recovery/verify': { user: fakeUser, recoveryCodesRemaining: 9 },
      '/auth/me': { user: fakeUser },
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Use a recovery code instead' }))
    await userEvent.type(screen.getByLabelText('Recovery code'), 'A7KM-9QR3-FXP2')
    await userEvent.click(screen.getByRole('button', { name: 'Use recovery code' }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/auth/2fa/recovery/verify',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  test('a failed passkey prompt shows an error and stays put', async () => {
    vi.stubGlobal(
      'fetch',
      fetchByUrl({ '/auth/2fa/authenticate/options': { challenge: 'abc' }, '/auth/me': {} }),
    )
    vi.mocked(startAuthentication).mockRejectedValue(new Error('prompt dismissed'))

    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Verify with passkey' }))

    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument()
  })
})
