import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { LoginPage } from './LoginPage'

const user = {
  id: 'u1',
  email: 'sam@example.test',
  emailVerified: true,
  name: 'Sam',
  linkedProviders: [],
}

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

// A successful password login (no 2FA): /auth/login returns a user, /auth/me confirms the session.
const stubLogin = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/login') && method === 'POST') {
        return jsonResponse({ user })
      }
      if (url.includes('/auth/me')) {
        return jsonResponse({ user })
      }
      return jsonResponse({})
    }),
  )

const LocationProbe = () => {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

const renderLogin = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/invite"
            element={
              <>
                <div>Invite page</div>
                <LocationProbe />
              </>
            }
          />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

const submitLogin = async () => {
  await userEvent.type(screen.getByLabelText('Email'), 'sam@example.test')
  await userEvent.type(screen.getByLabelText('Password'), 'correct horse battery staple')
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // The glue that makes invites work: a login that started mid-invite must return to /invite with the
  // token intact, not dump the user on the dashboard.
  test('logging in mid-invite returns to /invite with the token', async () => {
    stubLogin()
    renderLogin('/login?inviteToken=abc')
    await submitLogin()
    expect(await screen.findByText('Invite page')).toBeInTheDocument()
    expect(screen.getByTestId('location').textContent).toBe('/invite?inviteToken=abc')
  })

  test('an ordinary login (no invite) still lands on the dashboard', async () => {
    stubLogin()
    renderLogin('/login')
    await submitLogin()
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })
})
