import * as encoding from 'lib0/encoding'
import type * as awarenessProtocol from 'y-protocols/awareness'
import { encodeAwarenessUpdate } from 'y-protocols/awareness'
import { writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import type * as Y from 'yjs'

// Two logical channels multiplexed over one socket, picked by a leading varUint tag. 'sync' carries
// the document CRDT (the handshake + ongoing updates); 'awareness' carries ephemeral presence (who's
// here, where their cursor is). Naming the tags once keeps the wire format in a single source instead
// of bare 0/1 literals scattered through every encode/decode site — a mismatched byte is a silent
// protocol break, so there must be exactly one definition both ends agree on.
export const SYNC_MESSAGE = { sync: 0, awareness: 1 } as const
export type SyncMessageTag = (typeof SYNC_MESSAGE)[keyof typeof SYNC_MESSAGE]

// SyncStep1 = "here is my state vector; tell me what I'm missing." The server sends this the instant a
// client connects, opening the two-step exchange (the reply is SyncStep2 — the missing updates) that
// converges both sides regardless of who edited what while they were apart.
export const encodeSyncStep1 = (doc: Y.Doc): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
  writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

// Wrap one raw Yjs document update as a 'sync' update message — what the room fans out to the other
// connections after a real change.
export const encodeUpdate = (update: Uint8Array): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
  writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

// The awareness state for the given client ids, as an 'awareness' message. Sent to a newcomer so it
// sees everyone already present, and broadcast whenever a client's presence changes.
export const encodeAwareness = (
  awareness: awarenessProtocol.Awareness,
  clientIds: number[],
): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, SYNC_MESSAGE.awareness)
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clientIds))
  return encoding.toUint8Array(encoder)
}
