import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { getSessionUser } from '../auth/session.ts'
import { getDocumentAccessForUser } from '../documents/access.ts'
import { type DocRoom, type SyncConnection, joinRoom } from './doc-room.ts'

const syncParams = z.object({ id: z.string().uuid() })

// The realtime sync endpoint for one document. Path mirrors the REST route (/documents/:id/sync) so a
// single Vite proxy entry forwards both, and the join gate is the SAME effective-access resolver the REST
// GET uses (M5): owner OR a member of a team the doc is shared into. So "can read this over REST" and "can
// join its live room" are the same computation — parity by construction, not two checks kept in sync by
// hand. There is no live room you couldn't also read over REST.
//
// M5 LIMITATION (closed by M6): the gate only decides whether you may JOIN. It does NOT yet enforce your
// access LEVEL per message, so a read-level member who joins can currently still send edits over the ws
// (REST PATCH correctly 403s them — only this ws write path is open). M6 adds per-message canEditDoc in
// doc-room.ts to drop a reader's inbound updates. Deliberately not stashing access on the request here —
// that seam is M6's first move.
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
        const access = await getDocumentAccessForUser({
          documentId: parsed.data.id,
          userId: active.userId,
        })
        if (access === null) {
          return reply.code(404).send({ error: 'document_not_found' })
        }
      },
    },
    (socket, req) => {
      const documentId = (req.params as { id: string }).id

      // Adapt the ws socket to the room's minimal connection interface. The protocol is binary, so the
      // bytes go out as a binary frame; ws sends a Uint8Array as binary. Guard on readyState so a
      // broadcast to a socket that just closed is a no-op instead of a throw inside the room.
      const connection: SyncConnection = {
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
