import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAuthUser, parseOrThrow, requireAuthHook } from '../auth/route-helpers.ts'
import { forbidden, notFound } from '../lib/errors.ts'
import { listTeamsForDocument } from '../teams/assignments.ts'
import { DOCUMENT_ACCESS_OWNER, canWriteDocument, getDocumentAccessForUser } from './access.ts'
import {
  createDocument,
  deleteDocumentForOwner,
  listDocumentsForOwner,
  renameDocument,
} from './documents.ts'

const createDocumentBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
})

// Rename requires a real title — same trim/length rule as create, minus the optional: a PATCH that
// clears the name is a 400, not a silent "Untitled".
const renameDocumentBody = z.object({
  title: z.string().trim().min(1).max(200),
})

const documentIdParams = z.object({
  id: z.string().uuid(),
})

// Registered under /documents. Every route here requires a session, so authentication is an onRequest
// hook for the whole plugin (not re-awaited in each handler): requireAuthHook resolves the session once
// per request and rejects 401 before parsing, and handlers read the result via getAuthUser. Each is then
// scoped to the caller as owner. Encapsulated as its own plugin — the hook does not leak to other plugins.
export const documentRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('onRequest', requireAuthHook)

  app.get('/', async (req) => {
    const { userId } = getAuthUser(req)
    const documents = await listDocumentsForOwner(userId)
    return { documents }
  })

  app.post('/', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const input = parseOrThrow(createDocumentBody, req.body)
    const document = await createDocument({ ownerId: userId, title: input.title })
    return reply.code(201).send({ document })
  })

  // Read one document. With M5 this is no longer owner-only: the effective-access resolver lets a team
  // member reach a document shared into their team. A user who reaches it through no path (bad id, or a
  // real doc shared into no team of theirs) gets 404 — never a 403 that would confirm it exists. The
  // caller's own access level rides along in the response so the client can gate its UI (M9's read-only
  // editor). The ws sync upgrade resolves the SAME way (M5-4), so REST-read and room-join never diverge.
  app.get('/:id', async (req) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const resolved = await getDocumentAccessForUser({ documentId: id, userId })
    if (resolved === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return { document: resolved.document, access: resolved.access }
  })

  // Rename a document. Allowed for write+ access (owner, or a write/delete-level team member); a read-level
  // member who can SEE the doc gets 403 (they know it exists — they're on it), while someone with no access
  // at all gets 404. The resolver decides both, then canWriteDocument gates the write.
  app.patch('/:id', async (req) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const input = parseOrThrow(renameDocumentBody, req.body)
    const resolved = await getDocumentAccessForUser({ documentId: id, userId })
    if (resolved === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    if (!canWriteDocument(resolved.access)) {
      throw forbidden('document_read_only', 'You have read-only access to this document.')
    }
    const document = await renameDocument({ documentId: id, title: input.title })
    if (document === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return { document }
  })

  // Delete a document. Hard delete stays OWNER-ONLY, always — no team level grants it. A team member who can
  // see the doc (any level) gets 403, someone with no access gets 404. `delete`-LEVEL only lets a member
  // unassign the doc from a team (that's the teams route), never destroy it.
  app.delete('/:id', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const resolved = await getDocumentAccessForUser({ documentId: id, userId })
    if (resolved === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    if (resolved.access !== DOCUMENT_ACCESS_OWNER) {
      throw forbidden('document_delete_owner_only', 'Only the owner can delete a document.')
    }
    const removed = await deleteDocumentForOwner({ documentId: id, ownerId: userId })
    if (!removed) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return reply.code(204).send()
  })

  // The teams a document is shared into — the owner's share panel (M9). Owner-only: a team member who can
  // see the doc but doesn't own it gets 403, and a total stranger gets 404. Static child of `/:id`, so
  // Fastify routes `/:id/teams` here and `/:id` above with no clash.
  app.get('/:id/teams', async (req) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const resolved = await getDocumentAccessForUser({ documentId: id, userId })
    if (resolved === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    if (resolved.access !== DOCUMENT_ACCESS_OWNER) {
      throw forbidden(
        'document_teams_owner_only',
        'Only the owner can see where a document is shared.',
      )
    }
    const teams = await listTeamsForDocument(id)
    return { teams }
  })
}
