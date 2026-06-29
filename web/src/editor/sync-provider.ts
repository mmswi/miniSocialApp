import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import type { Doc } from 'yjs'

// The wire format, MUST match the server's src/sync/sync-protocol.ts SYNC_MESSAGE. A deliberate
// client-side mirror — web/ can't import the server module without dragging the backend into the bundle
// — so it carries a distinct name and this note: a mismatched tag is a silent protocol break, keep the
// two in sync by hand. (Same pattern as CLIENT_AUTH_PROVIDERS.)
const CLIENT_SYNC_MESSAGE = { sync: 0, awareness: 1 } as const

//   'connecting'    a socket is opening (initial, or a reconnect attempt in flight)
//   'connected'     the socket is open and the handshake has been sent
//   'disconnected'  no socket; a reconnect is scheduled with backoff
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export type SyncProvider = {
  // The caret extension reads provider.awareness; the editor binds to provider.doc via Collaboration.
  awareness: Awareness
  doc: Doc
  destroy: () => void
}

const MAX_BACKOFF_MS = 15_000

// The client half of the hand-built sync protocol (the server half is src/sync). It opens a WebSocket
// to /documents/:id/sync, runs the SyncStep1/Step2 handshake, mirrors local edits up and remote updates
// down, relays awareness, and reconnects with exponential backoff. The self-echo guard is the same idea
// as the server's: tag updates applied FROM the socket with a sentinel origin, and never send those back.
export const createSyncProvider = (input: {
  documentId: string
  doc: Doc
  onStatusChange?: (status: ConnectionStatus) => void
}): SyncProvider => {
  const { documentId, doc, onStatusChange } = input
  const awareness = new Awareness(doc)

  // A unique sentinel used as the transaction origin when applying anything that came FROM the server.
  // The doc/awareness update handlers check identity against it to avoid echoing the server's own data
  // back at it (which would loop).
  const remoteOrigin: { remote: true } = { remote: true }

  let socket: WebSocket | null = null
  let destroyed = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const setStatus = (status: ConnectionStatus): void => {
    onStatusChange?.(status)
  }

  const send = (data: Uint8Array): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(data)
    }
  }

  const sendSyncStep1 = (): void => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, CLIENT_SYNC_MESSAGE.sync)
    writeSyncStep1(encoder, doc)
    send(encoding.toUint8Array(encoder))
  }

  const sendAwareness = (clientIds: number[]): void => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, CLIENT_SYNC_MESSAGE.awareness)
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clientIds))
    send(encoding.toUint8Array(encoder))
  }

  // Local edits go up; updates the server handed us (origin === remoteOrigin) do not bounce back.
  const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === remoteOrigin) {
      return
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, CLIENT_SYNC_MESSAGE.sync)
    writeUpdate(encoder, update)
    send(encoding.toUint8Array(encoder))
  }

  const onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === remoteOrigin) {
      return
    }
    sendAwareness([...change.added, ...change.updated, ...change.removed])
  }

  const handleMessage = (event: MessageEvent): void => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
    const tag = decoding.readVarUint(decoder)
    if (tag === CLIENT_SYNC_MESSAGE.sync) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, CLIENT_SYNC_MESSAGE.sync)
      readSyncMessage(decoder, encoder, doc, remoteOrigin)
      if (encoding.length(encoder) > 1) {
        send(encoding.toUint8Array(encoder))
      }
    } else if (tag === CLIENT_SYNC_MESSAGE.awareness) {
      applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), remoteOrigin)
    }
  }

  const scheduleReconnect = (): void => {
    if (destroyed) {
      return
    }
    reconnectAttempts += 1
    // Exponential backoff (1s, 2s, 4s, … capped at 15s) plus up to 30% jitter, so a server restart
    // doesn't get a synchronized thundering herd of every client reconnecting in the same millisecond.
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (reconnectAttempts - 1))
    const delay = backoff + backoff * 0.3 * Math.random()
    reconnectTimer = setTimeout(connect, delay)
  }

  function connect(): void {
    if (destroyed) {
      return
    }
    setStatus('connecting')
    // Same-origin URL: in dev the Vite proxy forwards /documents (ws:true) to the API; in prod the app
    // and API share an origin. So the cookie rides the upgrade and there's no CORS to configure.
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const next = new WebSocket(`${scheme}://${window.location.host}/documents/${documentId}/sync`)
    next.binaryType = 'arraybuffer'
    socket = next

    next.addEventListener('open', () => {
      reconnectAttempts = 0
      setStatus('connected')
      // Announce our state vector so the server replays anything we missed, then re-publish our presence
      // (a reconnect needs to re-assert the cursor the server dropped when the old socket closed).
      sendSyncStep1()
      if (awareness.getLocalState() !== null) {
        sendAwareness([doc.clientID])
      }
    })
    next.addEventListener('message', handleMessage)
    next.addEventListener('close', () => {
      if (socket === next) {
        socket = null
      }
      setStatus('disconnected')
      scheduleReconnect()
    })
    // An 'error' is always followed by 'close', so reconnection is handled there — nothing to do here
    // beyond not letting the unhandled event bubble.
    next.addEventListener('error', () => {})
  }

  doc.on('update', onDocUpdate)
  awareness.on('update', onAwarenessUpdate)
  connect()

  const destroy = (): void => {
    destroyed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
    }
    doc.off('update', onDocUpdate)
    awareness.off('update', onAwarenessUpdate)
    // Tell everyone our cursor is gone, then drop the socket. (The doc itself is destroyed by the page —
    // the provider doesn't own it.)
    removeAwarenessStates(awareness, [doc.clientID], 'provider-destroyed')
    awareness.destroy()
    if (socket !== null) {
      socket.close()
      socket = null
    }
  }

  return { awareness, doc, destroy }
}
