import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthProvider } from '../auth/AuthProvider'
import { DocumentEditorPage } from './DocumentEditorPage'

// The editor page mounts a real Yjs doc + ws sync provider + TipTap editor — none of which belong in a unit
// test of the read-only gating. Mock all three: a fake provider (no socket), a stand-in editor that reports
// the `editable` prop it was handed, and a stand-in title that marks itself as the editable variant. What's
// left to assert is exactly this milestone's job — the access → editable + View-only + static-title wiring.
vi.mock('../editor/sync-provider', () => ({
  createSyncProvider: () => ({ destroy: () => {} }),
}))
vi.mock('../editor/CollaborativeEditor', () => ({
  CollaborativeEditor: ({ editable }: { editable: boolean }) => (
    <div>editor editable={String(editable)}</div>
  ),
}))
vi.mock('../editor/DocumentTitle', () => ({
  DocumentTitle: ({ title }: { title: string }) => <span>editable-title:{title}</span>,
}))

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

const stubApi = (access: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/auth/me')) {
        return jsonResponse(me)
      }
      if (url.includes('/documents/')) {
        return jsonResponse({
          document: {
            id: 'doc-a',
            title: 'Q3 Launch Plan',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-20T00:00:00.000Z',
          },
          access,
        })
      }
      return jsonResponse({})
    }),
  )

const renderEditor = () =>
  render(
    <MemoryRouter initialEntries={['/editor/doc-a']}>
      <AuthProvider>
        <Routes>
          <Route path="/editor/:id" element={<DocumentEditorPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

describe('DocumentEditorPage read-only gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('a writer gets an editable editor, an editable title, and no View-only chip', async () => {
    stubApi('write')
    renderEditor()
    expect(await screen.findByText('editor editable=true')).toBeInTheDocument()
    expect(screen.getByText('editable-title:Q3 Launch Plan')).toBeInTheDocument()
    expect(screen.queryByText('View only')).not.toBeInTheDocument()
  })

  test('the owner also gets an editable editor', async () => {
    stubApi('owner')
    renderEditor()
    expect(await screen.findByText('editor editable=true')).toBeInTheDocument()
    expect(screen.queryByText('View only')).not.toBeInTheDocument()
  })

  test('a read-level viewer gets a non-editable editor, a static title, and a View-only chip', async () => {
    stubApi('read')
    renderEditor()
    expect(await screen.findByText('editor editable=false')).toBeInTheDocument()
    expect(screen.getByText('View only')).toBeInTheDocument()
    // The title is a plain static string, NOT the editable DocumentTitle stand-in.
    expect(screen.getByText('Q3 Launch Plan')).toBeInTheDocument()
    expect(screen.queryByText('editable-title:Q3 Launch Plan')).not.toBeInTheDocument()
  })
})
