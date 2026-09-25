import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { TeamPage } from './TeamPage'

const me = {
  user: {
    id: 'u1',
    email: 'me@example.test',
    emailVerified: true,
    name: 'Me',
    linkedProviders: [],
  },
}

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

const teamDoc = (id: string, title: string, ownerName: string | null): Record<string, unknown> => ({
  id,
  title,
  ownerName,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
})

// Serves everything the team page needs: /auth/me, the sidebar's teams list, the single team (getTeam),
// its documents + members, and invite POSTs. `getTeamStatus` lets a test make getTeam 404 (the not-found
// path). Order matters — the more specific /teams/:id/* paths are matched before the bare list.
const stubApi = (input: {
  role?: string
  getTeamStatus?: number
  documents?: Record<string, unknown>[]
  members?: Record<string, unknown>[]
}) => {
  const role = input.role ?? 'superadmin'
  const team = {
    id: 't-a',
    name: 'Design crew',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  }
  return vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
      }
      if (/\/teams\/[^/]+\/documents/.test(url)) {
        return jsonResponse({ documents: input.documents ?? [] })
      }
      if (/\/teams\/[^/]+\/members/.test(url)) {
        return jsonResponse({ members: input.members ?? [] })
      }
      if (/\/teams\/[^/]+\/invites/.test(url) && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { email: string; role: string }
        return jsonResponse(
          { invite: { email: body.email, role: body.role, expiresAt: '2026-07-16T00:00:00.000Z' } },
          201,
        )
      }
      if (/\/teams\/[^/]+$/.test(url)) {
        const status = input.getTeamStatus ?? 200
        return status === 200
          ? jsonResponse({ team, role })
          : jsonResponse({ error: 'team_not_found', message: 'Team not found.' }, status)
      }
      if (url.includes('/teams')) {
        // The sidebar's team list.
        return jsonResponse({ teams: [{ ...team, role }] })
      }
      return jsonResponse({})
    }),
  )
}

const renderTeamPage = () =>
  render(
    <MemoryRouter initialEntries={['/team/t-a']}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<div>My space</div>} />
          <Route path="/team/:teamId" element={<TeamPage />} />
          <Route path="/editor/:id" element={<div>Editor open</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

describe('TeamPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('shows the team header, its documents, and its members', async () => {
    stubApi({
      role: 'superadmin',
      documents: [teamDoc('doc-a', 'Q3 Launch Plan', 'Ana')],
      members: [
        { userId: 'u1', name: 'Me', email: 'me@example.test', role: 'superadmin' },
        { userId: 'u2', name: null, email: 'sam@example.test', role: 'member' },
      ],
    })
    renderTeamPage()

    expect(await screen.findByRole('heading', { name: 'Design crew' })).toBeInTheDocument()
    expect(screen.getByText('Q3 Launch Plan')).toBeInTheDocument()
    // A nameless member falls back to their email.
    expect(screen.getByText('sam@example.test')).toBeInTheDocument()
  })

  test('a document links into its editor', async () => {
    stubApi({ documents: [teamDoc('doc-a', 'Q3 Launch Plan', 'Ana')] })
    renderTeamPage()
    const link = await screen.findByRole('link', { name: /Q3 Launch Plan/ })
    expect(link).toHaveAttribute('href', '/editor/doc-a')
  })

  test('a 404 renders a not-found state, not the team', async () => {
    stubApi({ getTeamStatus: 404 })
    renderTeamPage()
    expect(
      await screen.findByText(/isn’t? a member|not a member|doesn’t exist/i),
    ).toBeInTheDocument()
  })

  test('the Invite control is hidden from a plain member', async () => {
    stubApi({ role: 'member' })
    renderTeamPage()
    await screen.findByRole('heading', { name: 'Design crew' })
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument()
  })

  test('the superadmin can send an invite, confirming the recipient and collapsing the form', async () => {
    stubApi({ role: 'superadmin' })
    renderTeamPage()
    await screen.findByRole('heading', { name: 'Design crew' })

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await userEvent.type(screen.getByLabelText('Email'), 'sam@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))

    expect(await screen.findByText(/Invite sent to sam@example.test/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  test('an admin is offered the Member, Viewer and Admin roles', async () => {
    stubApi({ role: 'admin' })
    renderTeamPage()
    await screen.findByRole('heading', { name: 'Design crew' })

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
    expect(screen.getByRole('option', { name: /Member/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Viewer/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Admin/ })).toBeInTheDocument()
  })
})
