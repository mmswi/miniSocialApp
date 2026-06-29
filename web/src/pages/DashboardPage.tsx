import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Button } from '../components/Button'
import {
  API_createDocument,
  API_deleteDocument,
  API_listDocuments,
  CLIENT_AUTH_PROVIDERS,
  type DocumentMeta,
} from '../lib/api'

//   'loading'  the first list fetch is in flight
//   'ready'    the list loaded (possibly empty)
//   'error'    the list fetch failed — offer a retry rather than a blank page
type DocumentsStatus = 'loading' | 'ready' | 'error'

const formatLastEdited = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export const DashboardPage = () => {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const justLinkedGoogle = searchParams.get('linked') === 'google'

  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [documentsStatus, setDocumentsStatus] = useState<DocumentsStatus>('loading')
  const [isCreating, setIsCreating] = useState(false)

  const loadDocuments = useCallback(async () => {
    setDocumentsStatus('loading')
    try {
      const { documents: mine } = await API_listDocuments()
      setDocuments(mine)
      setDocumentsStatus('ready')
    } catch {
      setDocumentsStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadDocuments()
  }, [loadDocuments])

  const onCreateDocument = async () => {
    setIsCreating(true)
    try {
      const { document } = await API_createDocument()
      // Straight into the editor on the new (empty) document — that's where you actually start.
      navigate(`/editor/${document.id}`)
    } finally {
      setIsCreating(false)
    }
  }

  const onDeleteDocument = async (id: string) => {
    await API_deleteDocument(id)
    setDocuments((current) => current.filter((doc) => doc.id !== id))
  }

  const onSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  // RequireAuth only renders this when authenticated, so user is non-null; this guard is for types.
  if (user === null) {
    return null
  }

  // Hide "Connect Google" once it's linked: a user who signed in with Google already has it, and
  // re-linking the same identity is a confusing no-op (it returns success but changes nothing).
  const isGoogleLinked = user.linkedProviders.includes(CLIENT_AUTH_PROVIDERS.google)
  const hasNoDocuments = documentsStatus === 'ready' && documents.length === 0

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Your documents</h1>
          <Button
            type="button"
            onClick={onCreateDocument}
            disabled={isCreating}
            className="!w-auto px-4"
          >
            {isCreating ? 'Creating…' : 'New document'}
          </Button>
        </div>

        {justLinkedGoogle ? (
          <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            Google account linked.
          </p>
        ) : null}

        <div className="mt-4">
          {documentsStatus === 'loading' ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
          ) : null}

          {documentsStatus === 'error' ? (
            <div className="py-8 text-center text-sm text-slate-500">
              <p>Couldn’t load your documents.</p>
              <button
                type="button"
                onClick={() => void loadDocuments()}
                className="mt-2 font-medium text-slate-800 underline"
              >
                Try again
              </button>
            </div>
          ) : null}

          {hasNoDocuments ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No documents yet. Create your first one to get started.
            </p>
          ) : null}

          {documentsStatus === 'ready' && documents.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {documents.map((document) => (
                <li key={document.id} className="flex items-center justify-between py-3">
                  <Link to={`/editor/${document.id}`} className="group">
                    <p className="font-medium group-hover:underline">{document.title}</p>
                    <p className="text-xs text-slate-500">
                      Edited {formatLastEdited(document.updatedAt)}
                    </p>
                  </Link>
                  <button
                    type="button"
                    onClick={() => void onDeleteDocument(document.id)}
                    className="text-sm text-slate-400 hover:text-red-600"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-700">Account</h2>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Email</dt>
            <dd className="font-medium">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Name</dt>
            <dd className="font-medium">{user.name ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email verified</dt>
            <dd className="font-medium">
              {user.emailVerified ? (
                <span className="text-green-700">yes</span>
              ) : (
                <span className="text-amber-600">no — check your inbox</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="mt-6 space-y-2">
          {isGoogleLinked ? (
            <div className="flex items-center justify-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-600">
              <span className="text-green-700">✓</span> Google account connected
            </div>
          ) : (
            <Button
              variant="secondary"
              type="button"
              onClick={() => window.location.assign('/auth/google/link')}
            >
              Connect Google account
            </Button>
          )}
          <Link
            to="/security"
            className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-center text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50"
          >
            Two-factor authentication
          </Link>
          <Button type="button" onClick={onSignOut}>
            Log out
          </Button>
        </div>
      </div>
    </div>
  )
}
