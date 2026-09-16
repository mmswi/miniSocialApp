import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { messageYjsSyncStep1, messageYjsUpdate, readSyncMessage } from 'y-protocols/sync'
import type * as Y from 'yjs'
import { appendUpdate, loadDoc } from './doc-store.ts'
import { SYNC_MESSAGE, encodeAwareness, encodeSyncStep1, encodeUpdate } from './sync-protocol.ts'

/*
 * One live editing room per documentId. The room owns the in-memory Y.Doc and relays between everyone
 * connected to it. The data flow on an inbound edit:
 *
 *   client C sends a 'sync' update
 *        │
 *        ▼  readSyncMessage applies it to doc with origin = C
 *   doc 'update' fires (origin = C)
 *        │
 *        ├─► appendUpdate(documentId, update)        durable immediately (the data-loss guard)
 *        └─► broadcast to every connection EXCEPT C   the self-echo guard — C already has the edit
 *
 * Yjs fires 'update' only for changes that actually mutate the doc, so a reconnecting client replaying
 * updates the server already has triggers neither a re-broadcast nor a duplicate append. The server is
 * a relay, not a participant: it holds no awareness state of its own.
 *
 * Single-instance for now. The cross-instance fan-out (publish each update to a Redis channel, ignore
 * your own echoes by instance id) is step 9 — it slots into the same doc 'update' handler.
 */

// What the room needs of a connection: a way to push bytes, a stable identity (the object itself) so the
// self-echo guard and awareness cleanup can tell connections apart, and whether this connection is allowed
// to WRITE the document. The ws route adapts a real socket to this. canEditDoc is required (no default) so
// every construction site must decide it — a silent writable default would be a security hole, letting a
// read-only viewer edit just because someone forgot to set the flag. It's resolved once at join from the
// same effective access the REST routes use (M6): owner/write/delete → true, read → false.
export type SyncConnection = {
  send: (data: Uint8Array) => void
  canEditDoc: boolean
}

export type DocRoom = {
  documentId: string
  doc: Y.Doc
  connections: Set<SyncConnection>
  addConnection: (conn: SyncConnection) => void
  removeConnection: (conn: SyncConnection) => void
  handleMessage: (conn: SyncConnection, message: Uint8Array) => void
}

// documentId → the room (as a Promise, so two clients opening the same doc at once await ONE creation
// rather than racing to build two rooms over the same document).
const rooms = new Map<string, Promise<DocRoom>>()

const destroyRoom = (documentId: string): void => {
  const roomPromise = rooms.get(documentId)
  rooms.delete(documentId)
  // The doc's content is already persisted in the update log; the next join reloads it from there.
  void roomPromise?.then((room) => room.doc.destroy())
}

const createRoom = async (documentId: string): Promise<DocRoom> => {
  const doc = await loadDoc(documentId)
  const awareness = new Awareness(doc)
  // The server relays presence but is not present itself, so it announces no local state.
  awareness.setLocalState(null)

  const connections = new Set<SyncConnection>()
  // Which awareness client ids each connection introduced, so a disconnect can retract exactly that
  // connection's cursors (and no one else's) — otherwise a closed tab leaves a ghost cursor behind.
  const controlledIds = new Map<SyncConnection, Set<number>>()

  const broadcast = (message: Uint8Array, except: SyncConnection | null): void => {
    for (const conn of connections) {
      if (conn !== except) {
        conn.send(message)
      }
    }
  }

  // origin is whatever readSyncMessage / applyAwarenessUpdate was handed as the source. For a local
  // edit that's the originating connection; for the initial load it's undefined. Resolve it to a known
  // connection (or null) so we can both skip the sender and track its presence.
  const senderOf = (origin: unknown): SyncConnection | null =>
    connections.has(origin as SyncConnection) ? (origin as SyncConnection) : null

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    broadcast(encodeUpdate(update), senderOf(origin))
    void appendUpdate(documentId, update).catch((err) => {
      // The edit is already live for everyone; losing only its durable copy is the failure we care
      // about, so it must be loud, not swallowed. M8 hardens this into an awaited, acked write.
      console.error(`[sync] failed to persist update for ${documentId}`, err)
    })
  })

  awareness.on(
    'update',
    (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
      const sender = senderOf(origin)
      if (sender !== null) {
        const owned = controlledIds.get(sender) ?? new Set<number>()
        for (const id of change.added) {
          owned.add(id)
        }
        for (const id of change.removed) {
          owned.delete(id)
        }
        controlledIds.set(sender, owned)
      }
      const changedClients = [...change.added, ...change.updated, ...change.removed]
      broadcast(encodeAwareness(awareness, changedClients), sender)
    },
  )

  const addConnection = (conn: SyncConnection): void => {
    connections.add(conn)
    // Open the handshake: SyncStep1 asks the client what it's missing. Then hand it the current
    // presence so it sees who is already here, not only people who move after it arrives.
    conn.send(encodeSyncStep1(doc))
    const presentClients = [...awareness.getStates().keys()]
    if (presentClients.length > 0) {
      conn.send(encodeAwareness(awareness, presentClients))
    }
  }

  const removeConnection = (conn: SyncConnection): void => {
    connections.delete(conn)
    const owned = controlledIds.get(conn)
    if (owned !== undefined && owned.size > 0) {
      // Retract this connection's cursors for everyone else — origin null so we don't attribute the
      // removal to a live connection.
      removeAwarenessStates(awareness, [...owned], null)
    }
    controlledIds.delete(conn)
    if (connections.size === 0) {
      destroyRoom(documentId)
    }
  }

  const handleMessage = (conn: SyncConnection, message: Uint8Array): void => {
    const decoder = decoding.createDecoder(message)
    const tag = decoding.readVarUint(decoder)
    if (tag === SYNC_MESSAGE.sync) {
      // Read-only enforcement (M6): peek the inner y-protocols sync type WITHOUT advancing the decoder
      // (peekVarUint leaves it for readSyncMessage below), and for a connection that may NOT write, allow
      // only SyncStep1 — the reader's own "what am I missing?" request, which we answer with SyncStep2 so
      // it can RECEIVE the document. SyncStep2 and Update both carry edits, so both are dropped. We do NOT
      // close the socket: a reader legitimately holds an open connection to keep receiving others' edits,
      // and closing would only trigger a reconnect storm. This is the per-message half of access control;
      // the join gate (ws-routes) is the other half, and both read the same effective access.
      const innerType = decoding.peekVarUint(decoder)
      if (!conn.canEditDoc && innerType !== messageYjsSyncStep1) {
        // A fresh reader's handshake reply is a (usually empty) SyncStep2 — benign, so it's dropped
        // silently. An Update is a genuine edit attempt from a client whose editor should be read-only:
        // worth a line, since it means either a forged message or a UI that failed to go read-only.
        if (innerType === messageYjsUpdate) {
          console.warn(`[sync] dropped a read-only connection's update for ${documentId}`)
        }
        return
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
      // Applies any updates with conn as the origin (this is what drives the self-echo guard above) and
      // writes a reply into the encoder when the message was a request (e.g. SyncStep1 → SyncStep2).
      readSyncMessage(decoder, encoder, doc, conn)
      // length 1 = only the tag byte = nothing to reply (a plain update needs no answer).
      if (encoding.length(encoder) > 1) {
        conn.send(encoding.toUint8Array(encoder))
      }
    } else if (tag === SYNC_MESSAGE.awareness) {
      // Awareness (cursors/presence) is never a document mutation, so a read-only connection may still send
      // it — a viewer's cursor should show. The future commenter tier (design doc, step 5) relies on this.
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn)
    }
  }

  return { documentId, doc, connections, addConnection, removeConnection, handleMessage }
}

// Join (creating the room on the first arrival), returning the room so the caller can route this
// connection's messages and removal to it.
export const joinRoom = async (documentId: string, conn: SyncConnection): Promise<DocRoom> => {
  let roomPromise = rooms.get(documentId)
  if (roomPromise === undefined) {
    roomPromise = createRoom(documentId)
    rooms.set(documentId, roomPromise)
  }
  const room = await roomPromise
  room.addConnection(conn)
  return room
}
