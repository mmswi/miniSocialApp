import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ROLES,
  type TeamRole,
  documentTeamsTable,
  documentsTable,
  teamMembersTable,
} from '../db/schema.ts'
import type { DocumentSummary } from './documents.ts'

// What a team member may do to a shared document. delete = may unshare it from the team.
export const DOCUMENT_ACCESS_LEVELS = { read: 'read', write: 'write', delete: 'delete' } as const
export type DocumentAccessLevel =
  (typeof DOCUMENT_ACCESS_LEVELS)[keyof typeof DOCUMENT_ACCESS_LEVELS]

const DOCUMENT_ACCESS_LEVEL_RANK: Record<DocumentAccessLevel, number> = {
  [DOCUMENT_ACCESS_LEVELS.read]: 1,
  [DOCUMENT_ACCESS_LEVELS.write]: 2,
  [DOCUMENT_ACCESS_LEVELS.delete]: 3,
}

// The level each team role gives on a document shared into the team.
const DOCUMENT_ACCESS_LEVEL_BY_TEAM_ROLE: Record<TeamRole, DocumentAccessLevel> = {
  [TEAM_ROLES.viewer]: DOCUMENT_ACCESS_LEVELS.read,
  [TEAM_ROLES.member]: DOCUMENT_ACCESS_LEVELS.write,
  [TEAM_ROLES.admin]: DOCUMENT_ACCESS_LEVELS.delete,
  [TEAM_ROLES.superadmin]: DOCUMENT_ACCESS_LEVELS.delete,
}

// The document's owner: full access, above every level.
export const DOCUMENT_ACCESS_OWNER = 'owner'

// What a user may do to a document: they own it, or the level their team role gives them.
export type DocumentAccess = typeof DOCUMENT_ACCESS_OWNER | DocumentAccessLevel

export type DocumentAccessResolution = {
  access: DocumentAccess
  document: DocumentSummary
}

// True when the access permits editing/renaming the document — write or better. The owner always may; a team
// member may when their effective level is write or delete; read → false. This is the ONE rule the REST
// write paths (PATCH rename) share, and the ws write-gate (M6) will read the same predicate — so "may this
// person write" can never be answered two different ways.
export const canWriteDocument = (access: DocumentAccess): boolean => {
  if (access === DOCUMENT_ACCESS_OWNER) {
    return true
  }
  const isWriteLevelOrHigher =
    DOCUMENT_ACCESS_LEVEL_RANK[access] >= DOCUMENT_ACCESS_LEVEL_RANK[DOCUMENT_ACCESS_LEVELS.write]
  return isWriteLevelOrHigher
}

// The heart of M5: one query resolves what a user may do to a document — as its owner, or through a team the
// document is shared into. Returns null when the user sees NO path to it (a bad id, or a real document that
// reaches them through no shared team), which every caller answers as 404 — the same no-enumeration-oracle
// rule teams use in doc 02, now applied to documents.
//
// The query starts from the document and LEFT JOINs outward: to its shares and — only for THIS user — each
// share's team membership. LEFT (not inner) so a document with no shares still returns one row carrying the
// document, which is what lets the owner check work even when nothing is shared:
//
//   documents ─LEFT─ document_teams ─LEFT─ team_members (team AND this user)
//
// Ownership is decided from documents.owner_id, not the joins. Otherwise we take the highest level the user's
// roles give them over the rows where they actually ARE a member (userRole is non-null).
export const getDocumentAccessForUser = async (input: {
  documentId: string
  userId: string
}): Promise<DocumentAccessResolution | null> => {
  const rows = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      ownerId: documentsTable.ownerId,
      createdAt: documentsTable.createdAt,
      updatedAt: documentsTable.updatedAt,
      // Non-null only when THIS user belongs to the share's team — marks a row that actually grants access.
      userRole: teamMembersTable.role,
    })
    .from(documentsTable)
    .leftJoin(documentTeamsTable, eq(documentTeamsTable.documentId, documentsTable.id))
    .leftJoin(
      teamMembersTable,
      and(
        eq(teamMembersTable.teamId, documentTeamsTable.teamId),
        eq(teamMembersTable.userId, input.userId),
      ),
    )
    .where(eq(documentsTable.id, input.documentId))

  const firstRow = rows[0]
  if (firstRow === undefined) {
    return null // no such document
  }

  const document: DocumentSummary = {
    id: firstRow.id,
    title: firstRow.title,
    createdAt: firstRow.createdAt,
    updatedAt: firstRow.updatedAt,
  }

  if (firstRow.ownerId === input.userId) {
    return { access: DOCUMENT_ACCESS_OWNER, document }
  }

  // A share whose team the user is not in has userRole null and grants nothing.
  const userRolesInSharedTeams = rows
    .map((row) => row.userRole)
    .filter((userRole): userRole is TeamRole => userRole !== null)
  const levelsFromUserRoles = userRolesInSharedTeams.map(
    (userRole) => DOCUMENT_ACCESS_LEVEL_BY_TEAM_ROLE[userRole],
  )
  const [highestLevel] = levelsFromUserRoles.sort(
    (firstLevel, secondLevel) =>
      DOCUMENT_ACCESS_LEVEL_RANK[secondLevel] - DOCUMENT_ACCESS_LEVEL_RANK[firstLevel],
  )

  if (highestLevel === undefined) {
    return null // the document exists, but the user reaches it through no shared team → 404, no oracle
  }
  return { access: highestLevel, document }
}
