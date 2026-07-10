import { type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Button } from '../components/Button'
import { SelectField } from '../components/SelectField'
import { TextField } from '../components/TextField'
import {
  API_createDocument,
  API_createInvite,
  API_createTeam,
  API_deleteDocument,
  API_listDocuments,
  API_listTeams,
  ApiError,
  CLIENT_AUTH_PROVIDERS,
  CLIENT_TEAM_ACCESS_LEVELS,
  CLIENT_TEAM_ROLES,
  type ClientInvitableRole,
  type ClientTeamAccessLevel,
  type ClientTeamRole,
  type DocumentMeta,
  type TeamListItem,
} from '../lib/api'

//   'loading'  the first list fetch is in flight
//   'ready'    the list loaded (possibly empty)
//   'error'    the list fetch failed — offer a retry rather than a blank page
type ListStatus = 'loading' | 'ready' | 'error'

const formatLastEdited = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

// The access-level choices in the New-team form, each with a plain-language line for what it grants over
// documents shared into the team. Referencing the named constants (never a bare 'read') keeps the client
// mirror the single source of truth.
const teamAccessLevelOptions: { value: ClientTeamAccessLevel; label: string }[] = [
  { value: CLIENT_TEAM_ACCESS_LEVELS.read, label: 'Read — members can view shared documents' },
  { value: CLIENT_TEAM_ACCESS_LEVELS.write, label: 'Write — view and edit' },
  { value: CLIENT_TEAM_ACCESS_LEVELS.delete, label: 'Delete — view, edit, and remove' },
]

// Narrow the <select>'s raw string back to the enum at the boundary. A value the options never emit
// falls back to the safest ceiling instead of decaying to a bare string.
const toTeamAccessLevel = (value: string): ClientTeamAccessLevel =>
  teamAccessLevelOptions.find((option) => option.value === value)?.value ??
  CLIENT_TEAM_ACCESS_LEVELS.read

// The role choices in the invite form depend on who is asking: only an owner may confer admin (the
// server 403s otherwise), so an admin caller never even sees the option that would fail.
const inviteRoleOptions = (
  callerRole: ClientTeamRole,
): { value: ClientInvitableRole; label: string }[] => {
  const memberOption = {
    value: CLIENT_TEAM_ROLES.member,
    label: 'Member — can view and use shared documents',
  }
  const adminOption = {
    value: CLIENT_TEAM_ROLES.admin,
    label: 'Admin — can also manage members and invites',
  }
  return callerRole === CLIENT_TEAM_ROLES.owner ? [memberOption, adminOption] : [memberOption]
}

// Same boundary-narrowing as toTeamAccessLevel: anything that isn't exactly admin falls back to member,
// the least-privileged invitable role.
const toInvitableRole = (value: string): ClientInvitableRole =>
  value === CLIENT_TEAM_ROLES.admin ? CLIENT_TEAM_ROLES.admin : CLIENT_TEAM_ROLES.member

// Inviting is an admin-and-up action; a plain member's row hides the control entirely (role-gating by
// hiding, per the plan) rather than offering a button that would only 403.
const canInviteToTeam = (role: ClientTeamRole): boolean =>
  role === CLIENT_TEAM_ROLES.owner || role === CLIENT_TEAM_ROLES.admin

export const DashboardPage = () => {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const justLinkedGoogle = searchParams.get('linked') === 'google'

  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [documentsStatus, setDocumentsStatus] = useState<ListStatus>('loading')
  const [isCreating, setIsCreating] = useState(false)

  // Teams load independently of documents — one failing must not blank the other — so each has its own
  // status. The New-team form is an inline expand (house style: no modal), like SecurityPage's toggles.
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [teamsStatus, setTeamsStatus] = useState<ListStatus>('loading')
  const [isTeamFormOpen, setIsTeamFormOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [teamAccessLevel, setTeamAccessLevel] = useState<ClientTeamAccessLevel>(
    CLIENT_TEAM_ACCESS_LEVELS.read,
  )
  const [isCreatingTeam, setIsCreatingTeam] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)

  // The invite form is an inline expand under its team row (house style: no modal), one row at a time —
  // the state is simply WHICH team's form is open. The sent note is kept separately, keyed by team, so
  // the confirmation survives the form collapsing after a successful send.
  const [inviteFormTeamId, setInviteFormTeamId] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ClientInvitableRole>(CLIENT_TEAM_ROLES.member)
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSent, setInviteSent] = useState<{ teamId: string; email: string } | null>(null)

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

  const loadTeams = useCallback(async () => {
    setTeamsStatus('loading')
    try {
      const { teams: mine } = await API_listTeams()
      setTeams(mine ?? [])
      setTeamsStatus('ready')
    } catch {
      setTeamsStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadDocuments()
    void loadTeams()
  }, [loadDocuments, loadTeams])

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

  // Collapsing the form is also its reset — name, level, and any error all clear, so reopening starts clean.
  const closeTeamForm = () => {
    setIsTeamFormOpen(false)
    setTeamName('')
    setTeamAccessLevel(CLIENT_TEAM_ACCESS_LEVELS.read)
    setTeamError(null)
  }

  const onCreateTeam = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = teamName.trim()
    if (trimmedName === '') {
      return
    }
    setTeamError(null)
    setIsCreatingTeam(true)
    try {
      await API_createTeam({ name: trimmedName, accessLevel: teamAccessLevel })
      // No TeamPage yet, so we stay here: collapse the form and refetch so the new team shows with the
      // owner role the server assigned it.
      closeTeamForm()
      await loadTeams()
    } catch (caught) {
      setTeamError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setIsCreatingTeam(false)
    }
  }

  // Moving the open form — to another row, or away entirely (null) — is also its reset, mirroring
  // closeTeamForm: email, role, and any error clear, so every opening starts clean.
  const moveInviteForm = (teamId: string | null) => {
    setInviteFormTeamId(teamId)
    setInviteEmail('')
    setInviteRole(CLIENT_TEAM_ROLES.member)
    setInviteError(null)
  }

  const openInviteForm = (teamId: string) => {
    moveInviteForm(teamId)
    // A stale "sent" note under another row would read as this send's result — clear it on open.
    setInviteSent(null)
  }

  const onSendInvite = async (event: SyntheticEvent<HTMLFormElement>, teamId: string) => {
    event.preventDefault()
    const email = inviteEmail.trim()
    if (email === '') {
      return
    }
    setInviteError(null)
    setIsSendingInvite(true)
    try {
      const { invite } = await API_createInvite(teamId, { email, role: inviteRole })
      // The invite now exists only in the recipient's inbox. Confirm with the address the server echoed
      // (the normalized one it stored and emailed), then collapse the form.
      setInviteSent({ teamId, email: invite.email })
      moveInviteForm(null)
    } catch (caught) {
      setInviteError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setIsSendingInvite(false)
    }
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
  const hasNoTeams = teamsStatus === 'ready' && teams.length === 0
  const canSubmitTeam = !isCreatingTeam && teamName.trim() !== ''
  const canSendInvite = !isSendingInvite && inviteEmail.trim() !== ''

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
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Teams</h2>
          <Button
            type="button"
            variant={isTeamFormOpen ? 'secondary' : 'primary'}
            onClick={() => (isTeamFormOpen ? closeTeamForm() : setIsTeamFormOpen(true))}
            className="!w-auto px-4"
          >
            {isTeamFormOpen ? 'Cancel' : 'New team'}
          </Button>
        </div>

        {isTeamFormOpen ? (
          <form onSubmit={onCreateTeam} className="mt-4 space-y-3 border-b border-slate-100 pb-6">
            <TextField
              label="Team name"
              placeholder="e.g. Design crew"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
            />
            <SelectField
              label="Access level"
              value={teamAccessLevel}
              onChange={(event) => setTeamAccessLevel(toTeamAccessLevel(event.target.value))}
            >
              {teamAccessLevelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SelectField>
            {teamError ? (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{teamError}</p>
            ) : null}
            <Button type="submit" disabled={!canSubmitTeam}>
              {isCreatingTeam ? 'Creating…' : 'Create team'}
            </Button>
          </form>
        ) : null}

        <div className="mt-4">
          {teamsStatus === 'loading' ? (
            <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
          ) : null}

          {teamsStatus === 'error' ? (
            <div className="py-8 text-center text-sm text-slate-500">
              <p>Couldn’t load your teams.</p>
              <button
                type="button"
                onClick={() => void loadTeams()}
                className="mt-2 font-medium text-slate-800 underline"
              >
                Try again
              </button>
            </div>
          ) : null}

          {hasNoTeams ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No teams yet. Create one to share documents with others.
            </p>
          ) : null}

          {teamsStatus === 'ready' && teams.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {teams.map((team) => {
                const isInviteFormOpen = inviteFormTeamId === team.id
                const sentToEmail =
                  inviteSent !== null && inviteSent.teamId === team.id ? inviteSent.email : null
                return (
                  <li key={team.id} className="py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{team.name}</p>
                        <p className="text-xs text-slate-500">
                          {team.role} · {team.accessLevel} access
                        </p>
                      </div>
                      {canInviteToTeam(team.role) ? (
                        <button
                          type="button"
                          onClick={() =>
                            isInviteFormOpen ? moveInviteForm(null) : openInviteForm(team.id)
                          }
                          className="text-sm font-medium text-slate-600 hover:text-slate-900"
                        >
                          {isInviteFormOpen ? 'Cancel' : 'Invite'}
                        </button>
                      ) : null}
                    </div>

                    {sentToEmail !== null ? (
                      <p className="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
                        Invite sent to {sentToEmail}.
                      </p>
                    ) : null}

                    {isInviteFormOpen ? (
                      <form
                        onSubmit={(event) => void onSendInvite(event, team.id)}
                        className="mt-3 space-y-3 rounded-md bg-slate-50 p-3"
                      >
                        <TextField
                          label="Email"
                          type="email"
                          placeholder="colleague@example.com"
                          value={inviteEmail}
                          onChange={(event) => setInviteEmail(event.target.value)}
                        />
                        <SelectField
                          label="Role"
                          value={inviteRole}
                          onChange={(event) => setInviteRole(toInvitableRole(event.target.value))}
                        >
                          {inviteRoleOptions(team.role).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </SelectField>
                        {inviteError ? (
                          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                            {inviteError}
                          </p>
                        ) : null}
                        <Button type="submit" disabled={!canSendInvite}>
                          {isSendingInvite ? 'Sending…' : 'Send invite'}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                )
              })}
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
