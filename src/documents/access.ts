import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  TEAM_ACCESS_LEVELS,
  type TeamAccessLevel,
  documentTeamsTable,
  documentsTable,
  teamMembersTable,
  teamsTable,
} from '../db/schema.ts'
import { TEAM_ACCESS_LEVEL_RANK } from '../teams/authz.ts'
import type { DocumentSummary } from './documents.ts'

// 'owner' sits ABOVE the team access chain (read ⊂ write ⊂ delete): the owner's access is unconditional and
// full, not a grant from any team. Named once here so no route hard-codes the bare string 'owner'.
export const DOCUMENT_ACCESS_OWNER = 'owner'

// What a user may do to a document: they own it (full), or they reach it through a team at that team's level.
// The union of the owner marker and the team levels — the single answer the resolver returns and the routes
// branch on.
export type DocumentAccess = typeof DOCUMENT_ACCESS_OWNER | TeamAccessLevel

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
  return TEAM_ACCESS_LEVEL_RANK[access] >= TEAM_ACCESS_LEVEL_RANK[TEAM_ACCESS_LEVELS.write]
}

// The heart of M5: one query resolves what a user may do to a document — as its owner, or through a team the
// document is shared into. Returns null when the user sees NO path to it (a bad id, or a real document that
// reaches them through no shared team), which every caller answers as 404 — the same no-enumeration-oracle
// rule teams use in doc 02, now applied to documents.
//
// The query starts from the document and LEFT JOINs outward: to its shares, to each share's team, and — only
// for THIS user — that team's membership. LEFT (not inner) so a document with no shares still returns one row
// carrying the document, which is what lets the owner check work even when nothing is shared:
//
//   documents ─LEFT─ document_teams ─LEFT─ team_members (team AND this user) ─LEFT─ teams
//
// Ownership is decided from documents.owner_id, not the joins. Otherwise we take the MAX team access level
// over the rows where the user actually IS a member (callerRole is non-null), via TEAM_ACCESS_LEVEL_RANK.
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
      callerRole: teamMembersTable.role,
      // The team's access level for that share. Present for any share; it only counts when callerRole is set.
      teamAccessLevel: teamsTable.accessLevel,
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
    .leftJoin(teamsTable, eq(teamsTable.id, documentTeamsTable.teamId))
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

  // The max access level over the teams that contain BOTH this document and this user. A share whose team the
  // user is not in (callerRole null) grants nothing and is skipped.
  let bestLevel: TeamAccessLevel | null = null
  for (const row of rows) {
    const level = row.teamAccessLevel
    const isMemberOfShareTeam = row.callerRole !== null
    if (!isMemberOfShareTeam || level === null) {
      continue
    }
    if (bestLevel === null || TEAM_ACCESS_LEVEL_RANK[level] > TEAM_ACCESS_LEVEL_RANK[bestLevel]) {
      bestLevel = level
    }
  }

  if (bestLevel === null) {
    return null // the document exists, but the user reaches it through no shared team → 404, no oracle
  }
  return { access: bestLevel, document }
}
