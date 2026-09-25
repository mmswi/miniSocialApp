import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { AppShell } from './AppShell'

const me = {
  user: {
    id: 'u1',
    email: 'me@example.test',
    emailVerified: true,
    name: 'Me',
    linkedProviders: [],
  },
}

const team = (id: string, name: string, role = 'superadmin'): Record<string, string> => ({
  id,
  name,
  role,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
})

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

// The sidebar fetches /auth/me (via AuthProvider) and the teams list; a create POSTs then refetches, so
// `teams` is a mutable array the following GET reflects — the same trick the old dashboard stub used.
const stubApi = (initialTeams: Record<string, string>[]) => {
  const teams = [...initialTeams]
  return vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
      }
      if (url.includes('/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { name: string }
        const created = team(`team-${teams.length + 1}`, body.name)
        teams.push(created)
        return jsonResponse({ team: created }, 201)
      }
      if (url.includes('/teams')) {
        return jsonResponse({ teams })
      }
      return jsonResponse({})
    }),
  )
}

const renderShell = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route
            path="/"
            element={
              <AppShell>
                <div>My space content</div>
              </AppShell>
            }
          />
          <Route path="/team/:teamId" element={<div>Team page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

describe('AppShell sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('renders the main content and the My space link', async () => {
    stubApi([])
    renderShell()
    expect(await screen.findByText('My space content')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'My space' })).toBeInTheDocument()
  })

  test('lists the teams the user belongs to as links to their page', async () => {
    stubApi([team('t-a', 'Design crew')])
    renderShell()
    const link = await screen.findByRole('link', { name: 'Design crew' })
    expect(link).toHaveAttribute('href', '/team/t-a')
  })

  test('shows an empty state when there are no teams', async () => {
    stubApi([])
    renderShell()
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
  })

  test('creating a team navigates to its page', async () => {
    stubApi([])
    renderShell()
    await screen.findByText(/No teams yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New team' }))
    await userEvent.type(screen.getByLabelText('Team name'), 'Launch team')
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }))

    // After create, the shell routes to the new team's page.
    expect(await screen.findByText('Team page')).toBeInTheDocument()
  })

  test('the Create team button is disabled until a name is typed', async () => {
    stubApi([])
    renderShell()
    await screen.findByText(/No teams yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New team' }))
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Team name'), 'Ops')
    expect(screen.getByRole('button', { name: 'Create team' })).toBeEnabled()
  })
})
