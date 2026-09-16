import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as Y from 'yjs'
import { useAuth } from '../auth/AuthProvider'
import { CollaborativeEditor } from '../editor/CollaborativeEditor'
import { DocumentTitle } from '../editor/DocumentTitle'
import {
  type ConnectionStatus,
  type SyncProvider,
  createSyncProvider,
} from '../editor/sync-provider'
import { API_getDocument, ApiError, type ClientDocumentAccess, canEditWithAccess } from '../lib/api'

// A small fixed palette; each user gets a stable color from their id, so the same person is the same
// color in everyone's editor. ?? keeps the return a string under noUncheckedIndexedAccess.
const CARET_COLORS = [
  '#e11d48',
  '#7c3aed',
  '#0891b2',
  '#059669',
  '#d97706',
  '#db2777',
  '#4f46e5',
  '#0d9488',
]
const colorForUser = (userId: string): string => {
  let hash = 0
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  return CARET_COLORS[Math.abs(hash) % CARET_COLORS.length] ?? '#4f46e5'
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  // We auto-reconnect with backoff, so "disconnected" reads as the user-facing intent, not the state.
  disconnected: 'Reconnecting…',
}
const STATUS_DOT: Record<ConnectionStatus, string> = {
  connecting: 'bg-amber-400',
  connected: 'bg-green-500',
  disconnected: 'bg-red-500',
}

// One Y.Doc + provider belong together for the lifetime of an open document.
type EditorSession = { doc: Y.Doc; provider: SyncProvider }

export const DocumentEditorPage = () => {
  const { id } = useParams()
  const documentId = id ?? ''
  const { user } = useAuth()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [session, setSession] = useState<EditorSession | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [access, setAccess] = useState<ClientDocumentAccess | null>(null)
  const [notFound, setNotFound] = useState(false)

  // Create the Y.Doc + provider INSIDE the effect (not useMemo), so the lifecycle is StrictMode-safe:
  // a remount builds a fresh pair and the cleanup destroys exactly the one it built — never a cached,
  // already-torn-down instance. Recreated only when the document id changes.
  useEffect(() => {
    if (documentId === '') {
      return
    }
    const doc = new Y.Doc()
    const provider = createSyncProvider({ documentId, doc, onStatusChange: setStatus })
    setSession({ doc, provider })
    return () => {
      provider.destroy()
      doc.destroy()
      setSession(null)
    }
  }, [documentId])

  // The title AND the caller's access are metadata over REST; the document CONTENT arrives over the ws
  // sync. A 404 means the doc is unreachable (unknown, or shared with no team of yours) — show a not-found
  // state instead of an empty editor. Access is fetched here so the editor mounts already knowing whether
  // it's editable, rather than flipping to read-only after the fact.
  useEffect(() => {
    let active = true
    setNotFound(false)
    setTitle(null)
    setAccess(null)
    API_getDocument(documentId)
      .then(({ document, access: documentAccess }) => {
        if (active) {
          setTitle(document.title)
          setAccess(documentAccess)
        }
      })
      .catch((error: unknown) => {
        if (active && error instanceof ApiError && error.status === 404) {
          setNotFound(true)
        }
      })
    return () => {
      active = false
    }
  }, [documentId])

  // RequireAuth only renders this when authenticated, so user is non-null; this guard is for types.
  if (user === null) {
    return null
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-slate-600">This document doesn’t exist, or you don’t have access.</p>
        <Link to="/" className="mt-2 inline-block text-sm font-medium text-slate-800 underline">
          Back to your documents
        </Link>
      </div>
    )
  }

  // Access is known once the metadata fetch resolves. Until then we hold the editor on "Loading editor…"
  // rather than mount it editable and flip to read-only after — so a read-only viewer never gets a
  // momentary editable surface. canEdit mirrors the server's write rule; isViewOnly drives the UI cues.
  const canEdit = access !== null && canEditWithAccess(access)
  const isViewOnly = access !== null && !canEdit

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-4 flex items-end justify-between">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-slate-800">
            ← Documents
          </Link>
          <h1 className="text-lg font-semibold">
            {title === null ? (
              <span className="text-slate-400">Loading…</span>
            ) : canEdit ? (
              // Rename requires write+ (the server 403s a reader's PATCH), so a read-only viewer gets a
              // static title, not the editable DocumentTitle.
              <DocumentTitle documentId={documentId} title={title} onRenamed={setTitle} />
            ) : (
              <span>{title}</span>
            )}
          </h1>
        </div>
        <span className="flex items-center gap-2 text-xs text-slate-500">
          {isViewOnly ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
              View only
            </span>
          ) : null}
          <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        {session && access !== null ? (
          <CollaborativeEditor
            doc={session.doc}
            provider={session.provider}
            userName={user.name ?? user.email}
            userColor={colorForUser(user.id)}
            editable={canEdit}
          />
        ) : (
          <p className="py-8 text-center text-sm text-slate-500">Loading editor…</p>
        )}
      </div>
    </div>
  )
}
