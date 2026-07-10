import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { AuthCard } from '../components/AuthCard'
import { Button } from '../components/Button'
import { API_acceptInvite, API_previewInvite, ApiError, type InvitePreview } from '../lib/api'
import { INVITE_TOKEN_PARAM, withInviteToken } from '../lib/invite-link'

// The invite landing page, at the PUBLIC /invite?inviteToken=RAW the emailed link points to. It previews
// the invite for a logged-out visitor, routes them through login/signup carrying the token, and back here
// to accept once they're the right signed-in user. Deliberately NOT behind RequireAuth — previewing has
// to work before there's a session (the token in the URL is the capability, not a login).
export const InviteAcceptPage = () => {
  const [searchParams] = useSearchParams()
  const token = searchParams.get(INVITE_TOKEN_PARAM)
  const { status, user, signOut } = useAuth()
  const navigate = useNavigate()

  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)

  useEffect(() => {
    if (token === null) {
      setPreviewError('This invite link is missing its token.')
      setLoadingPreview(false)
      return
    }
    // `active` guards against a setState after unmount (or a token change mid-flight) — the fetch that
    // resolves late must not overwrite state that belongs to a newer render.
    let active = true
    const load = async () => {
      try {
        const { invite } = await API_previewInvite(token)
        if (active) {
          setPreview(invite)
        }
      } catch (caught) {
        if (active) {
          setPreviewError(
            caught instanceof ApiError
              ? caught.message
              : 'This invite link is invalid or has expired.',
          )
        }
      } finally {
        if (active) {
          setLoadingPreview(false)
        }
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [token])

  const onAccept = async () => {
    if (token === null) {
      return
    }
    setAcceptError(null)
    setAccepting(true)
    try {
      await API_acceptInvite(token)
      // TeamPage (/team/:id) isn't built yet; the dashboard refetches teams on mount, so the team just
      // joined shows up there. Land on it.
      navigate('/')
    } catch (caught) {
      setAcceptError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not accept the invite. Please try again.',
      )
      setAccepting(false)
    }
  }

  // Gate on BOTH async resolutions: the first /auth/me (status) AND the preview fetch. Branching while
  // either is still pending would flash the wrong state — e.g. the "log in" CTA at an already-signed-in
  // visitor for a beat before /auth/me lands.
  if (status === 'loading' || loadingPreview) {
    return (
      <AuthCard title="Team invitation">
        <p className="text-sm text-slate-600">Loading your invitation…</p>
      </AuthCard>
    )
  }

  if (previewError !== null || preview === null) {
    return (
      <AuthCard title="Invitation unavailable">
        <p className="text-sm text-slate-600">
          {previewError ?? 'This invite link is invalid or has expired.'}
        </p>
        <p className="mt-4 text-center text-sm text-slate-600">
          <Link to="/" className="font-medium text-slate-900 underline">
            Go to redline
          </Link>
        </p>
      </AuthCard>
    )
  }

  // Logged out: show the invite, then send them to auth carrying the token so they return here to accept.
  if (status === 'anonymous') {
    return (
      <AuthCard title={`Join ${preview.teamName}`}>
        <p className="text-sm text-slate-600">
          You've been invited to join <strong>{preview.teamName}</strong> as{' '}
          <strong>{preview.role}</strong>. The invite was sent to <strong>{preview.email}</strong> —
          sign in with that address to accept.
        </p>
        <div className="mt-4">
          <Button type="button" onClick={() => navigate(withInviteToken('/login', token))}>
            Log in to accept
          </Button>
        </div>
        <p className="mt-4 text-center text-sm text-slate-600">
          New to redline?{' '}
          <Link
            to={withInviteToken('/signup', token)}
            className="font-medium text-slate-900 underline"
          >
            Create an account
          </Link>
        </p>
      </AuthCard>
    )
  }

  // Signed in, but as someone other than the invitee. Accepting would 403 on the server (the email match),
  // so don't even offer the button — explain, and let them switch to the invited account.
  const signedInEmail = user?.email ?? ''
  const isInvitedUser = signedInEmail.toLowerCase() === preview.email.toLowerCase()
  if (!isInvitedUser) {
    return (
      <AuthCard title="Wrong account">
        <p className="text-sm text-slate-600">
          This invite is for <strong>{preview.email}</strong>, but you're signed in as{' '}
          <strong>{signedInEmail}</strong>. Log in with the invited address to accept it.
        </p>
        <div className="mt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              await signOut()
              navigate(withInviteToken('/login', token))
            }}
          >
            Log out and switch accounts
          </Button>
        </div>
      </AuthCard>
    )
  }

  // Signed in as the invitee — one click to join.
  return (
    <AuthCard title={`Join ${preview.teamName}`}>
      <p className="text-sm text-slate-600">
        You've been invited to join <strong>{preview.teamName}</strong> as{' '}
        <strong>{preview.role}</strong>.
      </p>
      {acceptError ? <p className="mt-3 text-sm text-red-600">{acceptError}</p> : null}
      <div className="mt-4">
        <Button type="button" disabled={accepting} onClick={onAccept}>
          {accepting ? 'Joining…' : 'Accept invitation'}
        </Button>
      </div>
    </AuthCard>
  )
}
