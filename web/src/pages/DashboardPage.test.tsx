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

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body })

const team = (id: string, name: string): Record<string, string> => ({
  id,
  name,
  role: 'superadmin',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
})

// One stub serves AuthProvider's /auth/me, the documents endpoints, the sidebar's /teams list, and the
// Share panel's reads/writes (a document's current shares + assign/unassign). `teams` is the caller's teams
// (checkbox rows); `shares` is which of them a document is already shared into. The more specific
// /teams/:id/documents and /documents/:id/teams paths are matched before the bare lists.
const stubApi = (input: {
  list: unknown[]
  created?: Record<string, string>
  teams?: Record<string, string>[]
  shares?: Record<string, string>[]
}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
      }
      if (/\/teams\/[^/]+\/documents\/[^/]+/.test(url) && method === 'DELETE') {
        return jsonResponse(null, 204)
      }
      if (/\/teams\/[^/]+\/documents/.test(url) && method === 'POST') {
        return jsonResponse({ document: input.created ?? {} }, 201)
      }
      if (/\/documents\/[^/]+\/teams/.test(url)) {
        return jsonResponse({ teams: input.shares ?? [] })
      }
      if (url.includes('/teams')) {
        return jsonResponse({ teams: input.teams ?? [] })
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
    // The new (empty) doc opens straight in the editor — navigation to /editor/doc-new.
    expect(await screen.findByText('Editor open')).toBeInTheDocument()
  })

  test('the Share panel lists your teams, pre-checking the ones the document is already in', async () => {
    stubApi({
      list: [doc('doc-a', 'Roadmap')],
      teams: [team('t-a', 'Design crew'), team('t-b', 'Ops')],
      shares: [team('t-a', 'Design crew')], // already shared into Design
    })
    renderDashboard()
    await screen.findByText('Roadmap')

    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    // A checkbox per team, the shared one checked, the other not.
    const design = await screen.findByRole('checkbox', { name: /Design crew/ })
    const ops = screen.getByRole('checkbox', { name: /Ops/ })
    expect(design).toBeChecked()
    expect(ops).not.toBeChecked()
  })

  test('checking a team shares the document; unchecking unshares it', async () => {
    stubApi({
      list: [doc('doc-a', 'Roadmap')],
      teams: [team('t-a', 'Design crew')],
      shares: [], // not shared with anyone yet
    })
    renderDashboard()
    await screen.findByText('Roadmap')

    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    const design = await screen.findByRole('checkbox', { name: /Design crew/ })
    expect(design).not.toBeChecked()

    // Check → assign → the box reflects it.
    await userEvent.click(design)
    expect(await screen.findByRole('checkbox', { name: /Design crew/ })).toBeChecked()

    // Uncheck → unassign → back to unchecked.
    await userEvent.click(screen.getByRole('checkbox', { name: /Design crew/ }))
    expect(await screen.findByRole('checkbox', { name: /Design crew/ })).not.toBeChecked()
  })

  test('the Share panel offers an empty state when you have no teams', async () => {
    stubApi({ list: [doc('doc-a', 'Roadmap')], teams: [] })
    renderDashboard()
    await screen.findByText('Roadmap')

    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByText(/not in any teams yet/)).toBeInTheDocument()
  })
})
