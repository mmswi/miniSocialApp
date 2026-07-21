import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { isUniqueViolation } from '../db/errors.ts'
import {
  type TeamAccessLevel,
  documentTeamsTable,
  documentsTable,
  teamsTable,
  usersTable,
} from '../db/schema.ts'
import type { DocumentSummary } from '../documents/documents.ts'

// A document shared into a team, as the team page lists it: the same summary the owner sees, plus WHO owns
// it — a team lists documents from several members, so "shared by Ana" needs a name. ownerName is nullable
// because users.name is (a user who never set one); the client falls back to something in that case.
export type TeamDocumentSummary = DocumentSummary & { ownerName: string | null }

// Two outcomes of an assign, named so the route decides 201 vs 409 without inspecting a raw db error: the
// share was created, or the (document, team) pair already existed. Tag values live in this const object so
// there are no bare 'created'/'already_shared' strings at the call sites (house discriminated-tag idiom).
export const DOCUMENT_ASSIGN_RESULTS = {
  created: 'created',
  alreadyShared: 'already_shared',
} as const
export type DocumentAssignResult =
  (typeof DOCUMENT_ASSIGN_RESULTS)[keyof typeof DOCUMENT_ASSIGN_RESULTS]

// Share a document into a team by inserting one document_teams row. The route has already proven the caller
// owns the doc and is a member of the team; this just records the share. The unique(document, team) index is
// the race-safe judge of "already shared": the first insert wins, a duplicate (double-click, retry, two
// tabs) surfaces as a 23505 here, which we report as alreadyShared → a clean 409, never a 500.
export const assignDocumentToTeam = async (input: {
  documentId: string
  teamId: string
  addedById: string
}): Promise<DocumentAssignResult> => {
  try {
    await db.insert(documentTeamsTable).values({
      documentId: input.documentId,
      teamId: input.teamId,
      addedById: input.addedById,
    })
    return DOCUMENT_ASSIGN_RESULTS.created
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return DOCUMENT_ASSIGN_RESULTS.alreadyShared
    }
    throw error
  }
}

// Remove one document's share with one team. Returns whether a row was actually deleted, so the route
// answers 404 when the pair wasn't shared (a bad id or an already-removed share) — the authorization to
// unassign is decided by the route, not by this delete's WHERE.
export const unassignDocumentFromTeam = async (input: {
  documentId: string
  teamId: string
}): Promise<boolean> => {
  const removed = await db
    .delete(documentTeamsTable)
    .where(
      and(
        eq(documentTeamsTable.documentId, input.documentId),
        eq(documentTeamsTable.teamId, input.teamId),
      ),
    )
    .returning({ id: documentTeamsTable.id })
  return removed.length > 0
}

// The documents shared into a team, most-recently-touched first — the team page's document list. Joins each
// share to its document and that document's owner for the display name. Scoping is the route's job (member+
// only): this trusts it's being called for a team the caller may see.
export const listTeamDocuments = async (teamId: string): Promise<TeamDocumentSummary[]> => {
  return db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      createdAt: documentsTable.createdAt,
      updatedAt: documentsTable.updatedAt,
      ownerName: usersTable.name,
    })
    .from(documentTeamsTable)
    .innerJoin(documentsTable, eq(documentsTable.id, documentTeamsTable.documentId))
    .innerJoin(usersTable, eq(usersTable.id, documentsTable.ownerId))
    .where(eq(documentTeamsTable.teamId, teamId))
    .orderBy(desc(documentsTable.updatedAt))
}

// One team a document is shared into, as the owner's share panel lists it: the team plus its access level,
// so the panel can show "Design — can edit". The other direction of listTeamDocuments.
export type DocumentTeamListItem = {
  id: string
  name: string
  accessLevel: TeamAccessLevel
}

// The teams a document is shared into, by name — feeds the owner-only GET /documents/:id/teams share panel.
// Owner-only scoping is the route's job; this just reads the shares for one document.
export const listTeamsForDocument = async (documentId: string): Promise<DocumentTeamListItem[]> => {
  return db
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      accessLevel: teamsTable.accessLevel,
    })
    .from(documentTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, documentTeamsTable.teamId))
    .where(eq(documentTeamsTable.documentId, documentId))
    .orderBy(asc(teamsTable.name))
}
