import * as decoding from 'lib0/decoding'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { createSyncProvider } from './sync-provider'

// A fake WebSocket: captures everything the provider sends and lets the test drive open/close. The
// provider checks readyState === WebSocket.OPEN, so OPEN must be 1 to match the real constant.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1
  static readonly CLOSED = 3
  url: string
  binaryType = 'blob'
  readyState = 0
  sent: Uint8Array[] = []
  closed = false
  private listeners: Record<string, ((event: unknown) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, cb: (event: unknown) => void): void {
    const forType = this.listeners[type] ?? []
    forType.push(cb)
    this.listeners[type] = forType
  }
  removeEventListener(): void {}
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }
  private emit(type: string): void {
    for (const cb of this.listeners[type] ?? []) {
      cb({})
    }
  }
  // Test driver: simulate the socket opening.
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }
}

// The leading varUint message tag (mirrors src/sync/sync-protocol.ts SYNC_MESSAGE).
const SYNC_TAG = 0
// y-protocols/sync sub-message markers: step1 = 0, update = 2.
const SYNC_STEP1 = 0
const SYNC_UPDATE = 2

const firstTwoMarkers = (message: Uint8Array): { tag: number; sub: number } => {
  const decoder = decoding.createDecoder(message)
  return { tag: decoding.readVarUint(decoder), sub: decoding.readVarUint(decoder) }
}

const lastSocket = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances.at(-1)
  if (socket === undefined) {
    throw new Error('no socket was opened')
  }
  return socket
}

describe('createSyncProvider', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('exposes the doc and an awareness instance', () => {
    const doc = new Y.Doc()
    const provider = createSyncProvider({ documentId: 'doc-1', doc })
    expect(provider.doc).toBe(doc)
    expect(provider.awareness).toBeDefined()
    provider.destroy()
  })

  test('sends SyncStep1 when the socket opens', () => {
    const doc = new Y.Doc()
    const provider = createSyncProvider({ documentId: 'doc-1', doc })
    const socket = lastSocket()
    expect(socket.url).toContain('/documents/doc-1/sync')

    socket.open()
    const markers = firstTwoMarkers(socket.sent[0] ?? new Uint8Array())
    expect(markers).toEqual({ tag: SYNC_TAG, sub: SYNC_STEP1 })
    provider.destroy()
  })

  test('reports status changes (connecting → connected)', () => {
    const statuses: string[] = []
    const doc = new Y.Doc()
    const provider = createSyncProvider({
      documentId: 'doc-1',
      doc,
      onStatusChange: (status) => statuses.push(status),
    })
    lastSocket().open()
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('connected')
    provider.destroy()
  })

  test('streams a local edit up as a sync update', () => {
    const doc = new Y.Doc()
    const provider = createSyncProvider({ documentId: 'doc-1', doc })
    const socket = lastSocket()
    socket.open()
    const sentBefore = socket.sent.length

    doc.getText('content').insert(0, 'hello')

    const updateMessages = socket.sent
      .slice(sentBefore)
      .map(firstTwoMarkers)
      .filter((m) => m.tag === SYNC_TAG && m.sub === SYNC_UPDATE)
    expect(updateMessages.length).toBeGreaterThan(0)
    provider.destroy()
  })

  test('destroy closes the socket', () => {
    const doc = new Y.Doc()
    const provider = createSyncProvider({ documentId: 'doc-1', doc })
    const socket = lastSocket()
    socket.open()
    provider.destroy()
    expect(socket.closed).toBe(true)
  })
})
