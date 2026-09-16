import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { getSessionUser } from '../auth/session.ts'
import {
  type DocumentAccess,
  canWriteDocument,
  getDocumentAccessForUser,
} from '../documents/access.ts'
import { type DocRoom, type SyncConnection, joinRoom } from './doc-room.ts'

// The effective access resolved at the upgrade, stashed for the connection handler — preValidation runs
// first and resolves it, the handler (a separate callback) needs it to set the connection's write flag.
// Same pattern as auth's `authSession` (route-helpers.ts): a per-request field on FastifyRequest.
declare module 'fastify' {
  interface FastifyRequest {
    documentAccess?: DocumentAccess
  }
}

const syncParams = z.object({ id: z.string().uuid() })

// The realtime sync endpoint for one document. Path mirrors the REST route (/documents/:id/sync) so a
// single Vite proxy entry forwards both. Access control is two gates, both reading the SAME effective
// access the REST routes use:
//   • JOIN gate (here, M5): the resolver decides who may open the room at all — owner OR a member of a team
//     the doc is shared into. "Can read over REST" and "can join the room" are one computation, so they
//     can't diverge. There is no live room you couldn't also read over REST.
//   • WRITE gate (M6): the resolved access becomes the connection's `canEditDoc` (via canWriteDocument);
//     doc-room.ts enforces it per message, dropping a read-level connection's edits while still letting it
//     receive. So a reader can join and watch, but not write — matching the REST PATCH 403.
export const syncRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get(
    '/documents/:id/sync',
    {
      websocket: true,
      // Auth-on-upgrade: this runs BEFORE the socket opens, so an unauthorized client never gets a live
      // connection — it gets a clean HTTP error on the upgrade instead. Same non-oracle rule as REST: a
      // doc you can't reach is 404, never 403.
      preValidation: async (req, reply) => {
        const parsed = syncParams.safeParse(req.params)
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_document_id' })
        }
        const rawToken = req.cookies[SESSION_COOKIE_NAME]
        const active = rawToken === undefined ? null : await getSessionUser(rawToken)
        if (active === null) {
          return reply.code(401).send({ error: 'not_authenticated' })
        }
        const resolved = await getDocumentAccessForUser({
          documentId: parsed.data.id,
          userId: active.userId,
        })
        if (resolved === null) {
          return reply.code(404).send({ error: 'document_not_found' })
        }
        // Hand the resolved access to the connection handler below (it can't re-resolve without a second
        // query). The handler turns it into the per-message write flag.
        req.documentAccess = resolved.access
      },
    },
    (socket, req) => {
      const documentId = (req.params as { id: string }).id

      // The write flag for this connection, from the access preValidation resolved. Fail closed: if the
      // field is somehow unset (it never is on this path — preValidation returns early on every failure),
      // treat the connection as read-only rather than silently writable.
      const canEditDoc = req.documentAccess !== undefined && canWriteDocument(req.documentAccess)

      // Adapt the ws socket to the room's minimal connection interface. The protocol is binary, so the
      // bytes go out as a binary frame; ws sends a Uint8Array as binary. Guard on readyState so a
      // broadcast to a socket that just closed is a no-op instead of a throw inside the room.
      const connection: SyncConnection = {
        canEditDoc,
        send: (data) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(data)
          }
        },
      }

      // Joining is async (it may load the doc from Postgres). Two things can happen before it resolves,
      // and both are handled: messages can arrive (the client sends SyncStep1 eagerly — buffer them),
      // and the socket can close (then we must undo the join, or the connection leaks into the room and
      // the room never tears down).
      let room: DocRoom | null = null
      let closedEarly = false
      const pending: Uint8Array[] = []

      socket.on('message', (raw: Buffer) => {
        // ws hands us a Buffer that may be a slice of a pooled allocation; wrap precisely so the decoder
        // doesn't read neighbouring bytes.
        const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        if (room === null) {
          pending.push(data)
        } else {
          room.handleMessage(connection, data)
        }
      })

      socket.on('close', () => {
        closedEarly = true
        room?.removeConnection(connection)
      })

      joinRoom(documentId, connection)
        .then((joined) => {
          if (closedEarly) {
            // The socket closed during the join window — joinRoom already added this connection, so undo
            // it here (the close handler ran while room was still null and could not).
            joined.removeConnection(connection)
            return
          }
          room = joined
          for (const message of pending) {
            joined.handleMessage(connection, message)
          }
          pending.length = 0
        })
        .catch((err) => {
          app.log.error({ err, documentId }, 'failed to join sync room')
          socket.close()
        })
    },
  )
}
