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

// One stub serves AuthProvider's /auth/me, the list GET /documents, and the create POST /documents.
// The create branch keys off the method, since both verbs hit the same path.
const stubApi = (input: { list: unknown[]; created?: Record<string, string> }) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
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
    // The new (empty) doc opens straight in the editor — navigation to /documents/doc-new.
    expect(await screen.findByText('Editor open')).toBeInTheDocument()
  })
})
