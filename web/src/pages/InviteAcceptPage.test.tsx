import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { InviteAcceptPage } from './InviteAcceptPage'

// The invite the preview endpoint returns by default — addressed to sam@example.test.
const invitePreview = {
  invite: { teamId: 't1', teamName: 'Design crew', email: 'sam@example.test', role: 'member' },
}

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

// One stub serves AuthProvider's /auth/me, the public preview, and accept. `me: undefined` → /auth/me is
// a 401 (anonymous); an object → authenticated as that user. `preview`/`acceptStatus` override the happy
// path so the invalid-link and error branches can be exercised.
const stubApi = (opts: {
  me?: Record<string, unknown>
  preview?: { body: unknown; status?: number }
  acceptStatus?: number
}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return opts.me === undefined
          ? jsonResponse({ error: 'not_authenticated' }, 401)
          : jsonResponse({ user: opts.me })
      }
      if (url.includes('/teams/invites/preview')) {
        const preview = opts.preview ?? { body: invitePreview }
        return jsonResponse(preview.body, preview.status ?? 200)
      }
      if (url.includes('/teams/invites/accept') && method === 'POST') {
        return jsonResponse(
          { team: { teamId: 't1', teamName: 'Design crew' } },
          opts.acceptStatus ?? 200,
        )
      }
      if (url.includes('/auth/logout')) {
        return jsonResponse(null, 204)
      }
      return jsonResponse({})
    }),
  )

// Renders the location the app navigated to, so tests can assert the token was carried across.
const LocationProbe = () => {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

const renderInvite = (entry = '/invite?inviteToken=abc') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/invite" element={<InviteAcceptPage />} />
          <Route
            path="/login"
            element={
              <>
                <div>Login page</div>
                <LocationProbe />
              </>
            }
          />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

const sam = {
  id: 'u1',
  email: 'sam@example.test',
  emailVerified: true,
  name: 'Sam',
  linkedProviders: [],
}

describe('InviteAcceptPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('a link with no token is a dead end, not a crash', async () => {
    stubApi({})
    renderInvite('/invite')
    expect(await screen.findByText(/missing its token/i)).toBeInTheDocument()
  })

  test('an invalid or used token shows the dead-link state', async () => {
    stubApi({
      preview: {
        body: {
          error: 'invalid_invite',
          message: 'This invite link is invalid or has already been used.',
        },
        status: 400,
      },
    })
    renderInvite()
    expect(await screen.findByText(/invalid or has already been used/i)).toBeInTheDocument()
  })

  test('logged out: shows the invite and routes to login carrying the token', async () => {
    stubApi({}) // me undefined → anonymous
    renderInvite()

    expect(await screen.findByRole('button', { name: 'Log in to accept' })).toBeInTheDocument()
    // The invited address is shown so the visitor knows which account to use.
    expect(screen.getByText('sam@example.test')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Log in to accept' }))
    expect(await screen.findByText('Login page')).toBeInTheDocument()
    // The token rode along, so login can bring them back to /invite afterward.
    expect(screen.getByTestId('location').textContent).toBe('/login?inviteToken=abc')
  })

  test('logged in as the invitee: accepting joins the team and lands on the app', async () => {
    stubApi({ me: sam })
    renderInvite()

    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  test('logged in as someone else: refuses to accept and explains the mismatch', async () => {
    stubApi({ me: { ...sam, id: 'u2', email: 'theo@example.test', name: 'Theo' } })
    renderInvite()

    expect(await screen.findByText(/Wrong account/i)).toBeInTheDocument()
    // Both the invited address and the signed-in one are named, so the fix is obvious.
    expect(screen.getByText('sam@example.test')).toBeInTheDocument()
    expect(screen.getByText('theo@example.test')).toBeInTheDocument()
    // No accept button is offered — the server would 403 anyway.
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
  })
})
