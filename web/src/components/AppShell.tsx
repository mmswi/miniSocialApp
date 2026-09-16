import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  API_createTeam,
  API_listTeams,
  ApiError,
  CLIENT_TEAM_ACCESS_LEVELS,
  type ClientTeamAccessLevel,
  type TeamListItem,
} from '../lib/api'
import { Button } from './Button'
import { SelectField } from './SelectField'
import { TextField } from './TextField'

//   'loading'  the teams fetch is in flight
//   'ready'    the list loaded (possibly empty)
//   'error'    the fetch failed — offer a retry rather than a blank sidebar
type ListStatus = 'loading' | 'ready' | 'error'

// The access-level choices in the New-team form, each with a plain-language line for what it grants over
// documents shared into the team. Referencing the named constants (never a bare 'read') keeps the client
// mirror the single source of truth. (Moved here from the dashboard with the create-team form.)
const teamAccessLevelOptions: { value: ClientTeamAccessLevel; label: string }[] = [
  { value: CLIENT_TEAM_ACCESS_LEVELS.read, label: 'Read — members can view shared documents' },
  { value: CLIENT_TEAM_ACCESS_LEVELS.write, label: 'Write — view and edit' },
  { value: CLIENT_TEAM_ACCESS_LEVELS.delete, label: 'Delete — view, edit, and remove' },
]

// Narrow the <select>'s raw string back to the enum at the boundary. A value the options never emit falls
// back to the safest ceiling instead of decaying to a bare string.
const toTeamAccessLevel = (value: string): ClientTeamAccessLevel =>
  teamAccessLevelOptions.find((option) => option.value === value)?.value ??
  CLIENT_TEAM_ACCESS_LEVELS.read

const navLinkClass = (isActive: boolean): string =>
  `block truncate rounded-md px-3 py-2 text-sm ${
    isActive ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
  }`

type Props = { children: ReactNode }

// The app shell: a persistent left sidebar (your personal space, the teams you belong to, and an inline
// New-team form) around whatever page sits in the main column. The dashboard and the team page both render
// inside it; the editor deliberately does NOT (it keeps a focused, full-width layout). The sidebar owns the
// teams list and creation — the one place "my teams" lives.
export const AppShell = ({ children }: Props) => {
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamListItem[]>([])
  const [teamsStatus, setTeamsStatus] = useState<ListStatus>('loading')
  const [isTeamFormOpen, setIsTeamFormOpen] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [teamAccessLevel, setTeamAccessLevel] = useState<ClientTeamAccessLevel>(
    CLIENT_TEAM_ACCESS_LEVELS.read,
  )
  const [isCreatingTeam, setIsCreatingTeam] = useState(false)
  const [teamError, setTeamError] = useState<string | null>(null)

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
    void loadTeams()
  }, [loadTeams])

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
      const { team } = await API_createTeam({ name: trimmedName, accessLevel: teamAccessLevel })
      closeTeamForm()
      await loadTeams()
      // Straight to the new (empty) team's page — that's where you add documents and invite people.
      navigate(`/team/${team.id}`)
    } catch (caught) {
      setTeamError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setIsCreatingTeam(false)
    }
  }

  const canSubmitTeam = !isCreatingTeam && teamName.trim() !== ''
  const hasNoTeams = teamsStatus === 'ready' && teams.length === 0

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8 md:flex-row">
      <aside className="w-full shrink-0 md:w-60">
        <nav className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <NavLink to="/" end className={({ isActive }) => navLinkClass(isActive)}>
            My space
          </NavLink>

          <div className="mt-4 flex items-center justify-between px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Teams
            </span>
            <button
              type="button"
              onClick={() => (isTeamFormOpen ? closeTeamForm() : setIsTeamFormOpen(true))}
              className="text-lg leading-none text-slate-400 hover:text-slate-900"
              aria-label={isTeamFormOpen ? 'Cancel new team' : 'New team'}
            >
              {isTeamFormOpen ? '×' : '+'}
            </button>
          </div>

          {isTeamFormOpen ? (
            <form onSubmit={onCreateTeam} className="mt-2 space-y-3 rounded-md bg-slate-50 p-3">
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

          <div className="mt-2">
            {teamsStatus === 'loading' ? (
              <p className="px-3 py-2 text-sm text-slate-400">Loading…</p>
            ) : null}

            {teamsStatus === 'error' ? (
              <button
                type="button"
                onClick={() => void loadTeams()}
                className="px-3 py-2 text-sm text-slate-500 underline"
              >
                Couldn’t load teams — retry
              </button>
            ) : null}

            {hasNoTeams ? <p className="px-3 py-2 text-xs text-slate-400">No teams yet.</p> : null}

            {teamsStatus === 'ready' && teams.length > 0 ? (
              <ul>
                {teams.map((team) => (
                  <li key={team.id}>
                    <NavLink
                      to={`/team/${team.id}`}
                      className={({ isActive }) => navLinkClass(isActive)}
                    >
                      {team.name}
                    </NavLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </nav>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
