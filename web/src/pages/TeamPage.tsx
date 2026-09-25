import { type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { Button } from '../components/Button'
import { SelectField } from '../components/SelectField'
import { TextField } from '../components/TextField'
import {
  API_createInvite,
  API_getTeam,
  API_listTeamDocuments,
  API_listTeamMembers,
  ApiError,
  CLIENT_TEAM_ROLES,
  type ClientInvitableRole,
  type ClientTeamRole,
  type TeamDocumentListItem,
  type TeamMemberListItem,
  type TeamMeta,
} from '../lib/api'

//   'loading'   the team + its documents/members are being fetched
//   'ready'     everything loaded
//   'notFound'  a 404 — not a member, or no such team (the server gives one answer for both, no oracle)
//   'error'     an unexpected failure — offer a retry
type PageStatus = 'loading' | 'ready' | 'notFound' | 'error'

const formatLastEdited = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const memberInviteOption = {
  value: CLIENT_TEAM_ROLES.member,
  label: 'Member — can view and edit documents',
} as const
const viewerInviteOption = {
  value: CLIENT_TEAM_ROLES.viewer,
  label: 'Viewer — can only view documents',
} as const
const adminInviteOption = {
  value: CLIENT_TEAM_ROLES.admin,
  label: 'Admin — can also manage members and invites',
} as const

// Only the superadmin invites admins (the server 403s otherwise).
const inviteRoleOptionsFor = (
  inviterRole: ClientTeamRole,
): { value: ClientInvitableRole; label: string }[] => {
  const canInviteAdmins = inviterRole === CLIENT_TEAM_ROLES.superadmin
  return canInviteAdmins
    ? [memberInviteOption, viewerInviteOption, adminInviteOption]
    : [memberInviteOption, viewerInviteOption]
}

// Narrow the <select>'s raw string back to an invitable role.
const toInvitableRole = (value: string): ClientInvitableRole =>
  [memberInviteOption, viewerInviteOption, adminInviteOption].find(
    (option) => option.value === value,
  )?.value ?? CLIENT_TEAM_ROLES.member

// Inviting is an admin-and-up action; a plain member never sees the control (role-gating by hiding) rather
// than a button that would only 403.
const canInviteToTeam = (role: ClientTeamRole): boolean =>
  role === CLIENT_TEAM_ROLES.superadmin || role === CLIENT_TEAM_ROLES.admin

export const TeamPage = () => {
  const { teamId } = useParams()
  const id = teamId ?? ''

  const [status, setStatus] = useState<PageStatus>('loading')
  const [team, setTeam] = useState<TeamMeta | null>(null)
  const [role, setRole] = useState<ClientTeamRole | null>(null)
  const [documents, setDocuments] = useState<TeamDocumentListItem[]>([])
  const [members, setMembers] = useState<TeamMemberListItem[]>([])

  const [isInviteOpen, setIsInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ClientInvitableRole>(CLIENT_TEAM_ROLES.member)
  const [isSendingInvite, setIsSendingInvite] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (id === '') {
      return
    }
    setStatus('loading')
    try {
      // getTeam proves membership (member+ → 404 otherwise); documents + members are the same member+ read,
      // so once getTeam succeeds they're safe to fetch together.
      const { team: fetchedTeam, role: fetchedRole } = await API_getTeam(id)
      const [{ documents: teamDocuments }, { members: teamMembers }] = await Promise.all([
        API_listTeamDocuments(id),
        API_listTeamMembers(id),
      ])
      setTeam(fetchedTeam)
      setRole(fetchedRole)
      setDocuments(teamDocuments)
      setMembers(teamMembers)
      setStatus('ready')
    } catch (caught) {
      setStatus(caught instanceof ApiError && caught.status === 404 ? 'notFound' : 'error')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // Collapsing the invite form is also its reset — email, role, and any error clear so reopening is clean.
  const closeInvite = () => {
    setIsInviteOpen(false)
    setInviteEmail('')
    setInviteRole(CLIENT_TEAM_ROLES.member)
    setInviteError(null)
  }

  const openInvite = () => {
    setIsInviteOpen(true)
    setInviteSentTo(null) // a stale "sent" note would read as this send's result — clear it on open
    setInviteError(null)
    setInviteEmail('')
    setInviteRole(CLIENT_TEAM_ROLES.member)
  }

  const onSendInvite = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault()
    const email = inviteEmail.trim()
    if (email === '') {
      return
    }
    setInviteError(null)
    setIsSendingInvite(true)
    try {
      const { invite } = await API_createInvite(id, { email, role: inviteRole })
      // Confirm with the normalized address the server echoed (never the raw token), then collapse.
      setInviteSentTo(invite.email)
      closeInvite()
    } catch (caught) {
      setInviteError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setIsSendingInvite(false)
    }
  }

  const canSendInvite = !isSendingInvite && inviteEmail.trim() !== ''

  return (
    <AppShell>
      {status === 'loading' ? (
        <p className="py-10 text-center text-sm text-slate-500">Loading…</p>
      ) : null}

      {status === 'notFound' ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-slate-600">This team doesn’t exist, or you’re not a member.</p>
          <Link to="/" className="mt-2 inline-block text-sm font-medium text-slate-800 underline">
            Back to My space
          </Link>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
          <p>Couldn’t load this team.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 font-medium text-slate-800 underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {status === 'ready' && team !== null && role !== null ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-xl font-semibold">{team.name}</h1>
            <p className="mt-1 text-sm text-slate-500">{role}</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Documents</h2>
            {documents.length === 0 ? (
              <p className="py-6 text-sm text-slate-500">
                No documents shared with this team yet. Share one from “My space”.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {documents.map((document) => (
                  <li key={document.id} className="py-3">
                    <Link to={`/editor/${document.id}`} className="group">
                      <p className="font-medium group-hover:underline">{document.title}</p>
                      <p className="text-xs text-slate-500">
                        {document.ownerName ?? 'A teammate'} · edited{' '}
                        {formatLastEdited(document.updatedAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Members</h2>
              {canInviteToTeam(role) ? (
                <Button
                  type="button"
                  variant={isInviteOpen ? 'secondary' : 'primary'}
                  className="!w-auto px-4"
                  onClick={() => (isInviteOpen ? closeInvite() : openInvite())}
                >
                  {isInviteOpen ? 'Cancel' : 'Invite'}
                </Button>
              ) : null}
            </div>

            {inviteSentTo !== null ? (
              <p className="mt-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
                Invite sent to {inviteSentTo}.
              </p>
            ) : null}

            {isInviteOpen ? (
              <form onSubmit={onSendInvite} className="mt-3 space-y-3 rounded-md bg-slate-50 p-3">
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
                  {inviteRoleOptionsFor(role).map((option) => (
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

            <ul className="mt-4 divide-y divide-slate-100">
              {members.map((member) => (
                <li key={member.userId} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{member.name ?? member.email}</p>
                    {member.name !== null ? (
                      <p className="text-xs text-slate-500">{member.email}</p>
                    ) : null}
                  </div>
                  <span className="text-xs text-slate-500">{member.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </AppShell>
  )
}
