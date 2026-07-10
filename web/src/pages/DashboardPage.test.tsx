import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { DashboardPage } from './DashboardPage'

const me = {
  user: {
    id: 'u1',
    email: 'me@example.test',
    emailVerified: true,
    name: 'Me',
    linkedProviders: [],
  },
}

const doc = (id: string, title: string): Record<string, string> => ({
  id,
  title,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
})

const team = (
  id: string,
  name: string,
  role = 'owner',
  accessLevel = 'read',
): Record<string, string> => ({
  id,
  name,
  role,
  accessLevel,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
})

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

// One stub serves AuthProvider's /auth/me plus the documents AND teams endpoints. `teams` is a MUTABLE
// array: a POST /teams pushes the new team and the following GET returns it — so the create flow, which
// refetches the list, actually sees what it just made (there's no TeamPage to navigate away to).
const stubApi = (input: {
  list: unknown[]
  created?: Record<string, string>
  teams?: Record<string, string>[]
}) => {
  const teams = [...(input.teams ?? [])]
  return vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
      }
      if (url.includes('/invites') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; role: string }
        // Echo like the server: the normalized address it stored, never the raw token.
        return jsonResponse(
          { invite: { email: body.email, role: body.role, expiresAt: '2026-07-16T00:00:00.000Z' } },
          201,
        )
      }
      if (url.includes('/teams') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          name: string
          accessLevel?: string
        }
        const createdTeam = team(
          `team-${teams.length + 1}`,
          body.name,
          'owner',
          body.accessLevel ?? 'read',
        )
        teams.push(createdTeam)
        return jsonResponse({ team: createdTeam }, 201)
      }
      if (url.includes('/teams')) {
        return jsonResponse({ teams })
      }
      if (url.includes('/documents') && method === 'POST') {
        return jsonResponse({ document: input.created }, 201)
      }
      if (url.includes('/documents')) {
        return jsonResponse({ documents: input.list })
      }
      return jsonResponse({})
    }),
  )
}

const renderDashboard = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <DashboardPage />
      </AuthProvider>
    </MemoryRouter>,
  )

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('lists the signed-in user’s documents', async () => {
    stubApi({ list: [doc('doc-a', 'Roadmap'), doc('doc-b', 'Meeting notes')] })
    renderDashboard()
    expect(await screen.findByText('Roadmap')).toBeInTheDocument()
    expect(screen.getByText('Meeting notes')).toBeInTheDocument()
  })

  test('shows an empty state when there are no documents', async () => {
    stubApi({ list: [] })
    renderDashboard()
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument()
  })

  test('creating a document opens its editor', async () => {
    stubApi({ list: [], created: doc('doc-new', 'Untitled document') })
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/editor/:id" element={<div>Editor open</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    await screen.findByText(/No documents yet/)
    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    // The new (empty) doc opens straight in the editor — navigation to /documents/doc-new.
    expect(await screen.findByText('Editor open')).toBeInTheDocument()
  })

  test('lists the teams the user belongs to, with their role', async () => {
    stubApi({ list: [], teams: [team('t-a', 'Design crew', 'owner', 'write')] })
    renderDashboard()
    expect(await screen.findByText('Design crew')).toBeInTheDocument()
    expect(screen.getByText(/owner · write access/)).toBeInTheDocument()
  })

  test('shows an empty teams state when there are none', async () => {
    stubApi({ list: [] })
    renderDashboard()
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
  })

  test('creating a team adds it to the list', async () => {
    stubApi({ list: [] })
    renderDashboard()
    await screen.findByText(/No teams yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New team' }))
    await userEvent.type(screen.getByLabelText('Team name'), 'Launch team')
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }))

    // The form collapses and the refetched list shows the new team owned by the creator.
    expect(await screen.findByText('Launch team')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New team' })).toBeInTheDocument()
  })

  test('the Invite control shows only on rows the user can administer', async () => {
    stubApi({
      list: [],
      teams: [team('t-a', 'Design crew', 'owner'), team('t-b', 'Ops', 'member')],
    })
    renderDashboard()
    await screen.findByText('Design crew')
    // One owner row, one member row — exactly one Invite button (member rows hide the control).
    expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(1)
  })

  test('sending an invite confirms the recipient and collapses the form', async () => {
    stubApi({ list: [], teams: [team('t-a', 'Design crew', 'owner')] })
    renderDashboard()
    await screen.findByText('Design crew')

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await userEvent.type(screen.getByLabelText('Email'), 'sam@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    expect(await screen.findByText(/Invite sent to sam@example.test/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  test('only an owner is offered the Admin role', async () => {
    stubApi({ list: [], teams: [team('t-a', 'Design crew', 'admin')] })
    renderDashboard()
    await screen.findByText('Design crew')

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
    // An admin caller can only confer member — the option that would 403 is never offered.
    expect(screen.getByRole('option', { name: /Member/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Admin/ })).not.toBeInTheDocument()
  })

  test('an owner can choose between Member and Admin', async () => {
    stubApi({ list: [], teams: [team('t-a', 'Design crew', 'owner')] })
    renderDashboard()
    await screen.findByText('Design crew')

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(screen.getByRole('option', { name: /Member/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Admin/ })).toBeInTheDocument()
  })

  test('the New team button is disabled until a name is typed', async () => {
    stubApi({ list: [] })
    renderDashboard()
    await screen.findByText(/No teams yet/)

    await userEvent.click(screen.getByRole('button', { name: 'New team' }))
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Team name'), 'Ops')
    expect(screen.getByRole('button', { name: 'Create team' })).toBeEnabled()
  })
})
