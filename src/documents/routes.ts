import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseOrThrow, requireSessionUser } from '../auth/route-helpers.ts'
import { notFound } from '../lib/errors.ts'
import {
  createDocument,
  deleteDocumentForOwner,
  getDocumentForOwner,
  listDocumentsForOwner,
} from './documents.ts'

const createDocumentBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
})

const documentIdParams = z.object({
  id: z.string().uuid(),
})

// Registered under /documents. Every route is gated by requireSessionUser — the single cookie→session
// check shared with the auth plugin — and scoped to the caller as owner. Encapsulated as its own
// plugin, so it inherits the app's cookie support and error handler from the parent context.
export const documentRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/', async (req) => {
    const { userId } = await requireSessionUser(req)
    const documents = await listDocumentsForOwner(userId)
    return { documents }
  })

  app.post('/', async (req, reply) => {
    const { userId } = await requireSessionUser(req)
    const input = parseOrThrow(createDocumentBody, req.body)
    const document = await createDocument({ ownerId: userId, title: input.title })
    return reply.code(201).send({ document })
  })

  app.get('/:id', async (req) => {
    const { userId } = await requireSessionUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const document = await getDocumentForOwner({ documentId: id, ownerId: userId })
    if (document === null) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return { document }
  })

  app.delete('/:id', async (req, reply) => {
    const { userId } = await requireSessionUser(req)
    const { id } = parseOrThrow(documentIdParams, req.params)
    const removed = await deleteDocumentForOwner({ documentId: id, ownerId: userId })
    if (!removed) {
      throw notFound('document_not_found', 'Document not found.')
    }
    return reply.code(204).send()
  })
}
