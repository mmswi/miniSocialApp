import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAuthUser, parseOrThrow, requireAuthHook } from '../auth/route-helpers.ts'
import { notFound } from '../lib/errors.ts'
import {
  createDocument,
  deleteDocumentForOwner,
  getDocumentForOwner,
  listDocumentsForOwner,
  renameDocumentForOwner,
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

  app.get('/:id', async (req) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const document = await getDocumentForOwner({ documentId: id, ownerId: userId })
    if (document === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return { document }
  })

  app.patch('/:id', async (req) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const input = parseOrThrow(renameDocumentBody, req.body)
    const document = await renameDocumentForOwner({
      documentId: id,
      ownerId: userId,
      title: input.title,
    })
    if (document === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return { document }
  })

  app.delete('/:id', async (req, reply) => {
    const { userId } = getAuthUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const removed = await deleteDocumentForOwner({ documentId: id, ownerId: userId })
    if (!removed) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return reply.code(204).send()
  })
}
