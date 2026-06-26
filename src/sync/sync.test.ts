import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { inArray } from 'drizzle-orm'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync'
import * as Y from 'yjs'
import { SESSION_COOKIE_NAME } from '../auth/cookies.ts'
import { createSession } from '../auth/session.ts'
import { db } from '../db/client.ts'
import { documentsTable, usersTable } from '../db/schema.ts'
import { buildServer } from '../server.ts'
import { loadDoc } from './doc-store.ts'
import { SYNC_MESSAGE } from './sync-protocol.ts'

// Integration tests against the REAL ws server (a live socket, the real upgrade + auth, the real
// protocol framing) — the go/no-go evidence: convergence, reconnect→resync→replay, durable reload, and
// auth-on-upgrade. The minimal client below speaks the same protocol the M3 browser provider will.
const app = buildServer()
let port = 0
const createdEmails: string[] = []
let ownerCookie = ''
let strangerCookie = ''
let ownerId = ''

const SHARED_TEXT = 'content'

const seedUser = async (prefix: string): Promise<{ id: string; cookie: string }> => {
  const email = `${prefix}-${randomUUID()}@example.test`
  createdEmails.push(email)
  const [user] = await db.insert(usersTable).values({ email }).returning()
  if (user === undefined) {
    throw new Error('failed to seed user')
  }
  const { rawToken } = await createSession({ userId: user.id })
  return { id: user.id, cookie: `${SESSION_COOKIE_NAME}=${rawToken}` }
}

// A fresh, empty document owned by the owner — one per test, so state never bleeds between them.
const freshDocument = async (): Promise<string> => {
  const [doc] = await db.insert(documentsTable).values({ ownerId, title: 'sync test' }).returning()
  if (doc === undefined) {
    throw new Error('failed to seed document')
  }
  return doc.id
}

const waitForOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      return resolve()
    }
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws errored before open')), { once: true })
  })

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type SyncClient = {
  doc: Y.Doc
  text: () => string
  type: (atEnd: string) => void
  close: () => Promise<void>
}

// The client half of the hand-built protocol: open a socket, run the SyncStep1/Step2 handshake, mirror
// local edits up and remote updates down — with the same self-echo guard (skip updates that came FROM
// the server). This is deliberately the seed of the M3 browser provider.
const connect = async (documentId: string, cookie: string): Promise<SyncClient> => {
  const doc = new Y.Doc()
  const url = `ws://127.0.0.1:${port}/documents/${documentId}/sync`
  const ws = new WebSocket(url, { headers: { cookie } } as unknown as string[])
  ws.binaryType = 'arraybuffer'

  ws.addEventListener('message', (event) => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer))
    const tag = decoding.readVarUint(decoder)
    if (tag === SYNC_MESSAGE.sync) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
      readSyncMessage(decoder, encoder, doc, ws)
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder))
      }
    }
  })

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // origin === ws means the server just handed us this update — don't bounce it back.
    if (origin === ws) {
      return
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
    writeUpdate(encoder, update)
    ws.send(encoding.toUint8Array(encoder))
  })

  await waitForOpen(ws)
  // Symmetric handshake: announce our state vector too, so the server sends us anything we're missing.
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)
  writeSyncStep1(encoder, doc)
  ws.send(encoding.toUint8Array(encoder))

  return {
    doc,
    text: () => doc.getText(SHARED_TEXT).toString(),
    type: (atEnd) => {
      const shared = doc.getText(SHARED_TEXT)
      shared.insert(shared.length, atEnd)
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          return resolve()
        }
        ws.addEventListener('close', () => resolve(), { once: true })
        ws.close()
      }),
  }
}

// True when the upgrade was REFUSED (errored or closed before ever opening) — the auth-on-upgrade path.
const upgradeRefused = (documentId: string, cookie?: string): Promise<boolean> =>
  new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}/documents/${documentId}/sync`
    const ws =
      cookie === undefined
        ? new WebSocket(url)
        : new WebSocket(url, { headers: { cookie } } as unknown as string[])
    let opened = false
    const settle = setTimeout(() => resolve(!opened), 1500)
    ws.addEventListener('open', () => {
      opened = true
      clearTimeout(settle)
      ws.close()
      resolve(false)
    })
    ws.addEventListener('error', () => {
      clearTimeout(settle)
      resolve(true)
    })
    ws.addEventListener('close', () => {
      if (!opened) {
        clearTimeout(settle)
        resolve(true)
      }
    })
  })

beforeAll(async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  port = Number(new URL(address).port)
  const owner = await seedUser('sync-owner')
  ownerId = owner.id
  ownerCookie = owner.cookie
  strangerCookie = (await seedUser('sync-stranger')).cookie
})

afterAll(async () => {
  // On Bun, app.close() waits forever on an open ws socket (a test may leave one). closeAllConnections
  // destroys the underlying sockets so close() resolves — the same move real graceful shutdown needs.
  app.server.closeAllConnections()
  await app.close()
  if (createdEmails.length > 0) {
    await db.delete(usersTable).where(inArray(usersTable.email, createdEmails))
  }
})

describe('hand-built ws sync', () => {
  test('an edit on one client propagates to the other (both directions)', async () => {
    const documentId = await freshDocument()
    const a = await connect(documentId, ownerCookie)
    const b = await connect(documentId, ownerCookie)

    a.type('hello from A')
    await waitFor(() => b.text() === 'hello from A')
    expect(b.text()).toBe('hello from A')

    b.type(' and B')
    await waitFor(() => a.text() === 'hello from A and B')
    expect(a.text()).toBe('hello from A and B')

    // A's own text is not doubled. (Weak evidence for the server-side self-echo guard: even a broken
    // guard would be absorbed by the client's origin check + Yjs idempotency — the real symptom would be
    // extra frames at the sender, not wrong text. The guard's correctness rests on the logic, not this.)
    expect(a.text()).toBe('hello from A and B')

    await a.close()
    await b.close()
  })

  test('concurrent edits at the same position converge to one deterministic state', async () => {
    const documentId = await freshDocument()
    const a = await connect(documentId, ownerCookie)
    const b = await connect(documentId, ownerCookie)

    // Both edit in the SAME tick, before either has seen the other — the actual concurrent case. Both
    // land at index 0 of an empty doc, so this also exercises Yjs's client-id tiebreak through our relay.
    a.type('AAA')
    b.type('BBB')

    // Converged = identical on both sides, and both edits survived (6 chars, neither clobbered).
    await waitFor(() => a.text().length === 6 && a.text() === b.text())
    expect(a.text()).toBe(b.text())
    expect(a.text().length).toBe(6)

    await a.close()
    await b.close()
  })

  test('concurrent edits at different positions both survive (the heading-vs-sentence case)', async () => {
    const documentId = await freshDocument()
    const a = await connect(documentId, ownerCookie)
    const b = await connect(documentId, ownerCookie)

    // A shared base both sides hold before they diverge.
    a.type('base')
    await waitFor(() => b.text() === 'base')

    // Now both edit concurrently in different places, neither having seen the other's change — exactly
    // the "Mara fixes the heading while Theo rewrites a sentence" case from the explainer doc.
    a.doc.getText(SHARED_TEXT).insert(0, 'A ')
    const bText = b.doc.getText(SHARED_TEXT)
    bText.insert(bText.length, ' B')

    await waitFor(() => a.text() === b.text() && a.text().includes('A ') && a.text().includes(' B'))
    expect(a.text()).toBe(b.text())
    // Both independent edits are present — nothing was clobbered by last-write-wins.
    expect(a.text()).toContain('A ')
    expect(a.text()).toContain('base')
    expect(a.text()).toContain(' B')

    await a.close()
    await b.close()
  })

  test('reconnect → resync → replay: a client that left catches up on return', async () => {
    const documentId = await freshDocument()
    const a = await connect(documentId, ownerCookie)
    const b = await connect(documentId, ownerCookie)

    a.type('first')
    await waitFor(() => b.text() === 'first')

    // A leaves; B stays, so the room lives on. B keeps editing while A is gone.
    await a.close()
    b.type(' second')
    await waitFor(() => b.text() === 'first second')

    // A returns: the handshake replays everything it missed.
    const aReturned = await connect(documentId, ownerCookie)
    await waitFor(() => aReturned.text() === 'first second')
    expect(aReturned.text()).toBe('first second')

    await b.close()
    await aReturned.close()
  })

  test('edits are durable: a brand-new room reloads the doc from Postgres', async () => {
    const documentId = await freshDocument()
    const a = await connect(documentId, ownerCookie)
    a.type('durable across restarts')

    // Wait until the update is actually persisted — loadDoc reads only Postgres, no live room.
    await waitFor(async () => {
      const reloaded = await loadDoc(documentId)
      return reloaded.getText(SHARED_TEXT).toString() === 'durable across restarts'
    })

    // Tear the room down completely, then a fresh client rebuilds purely from the log.
    await a.close()
    const reopened = await connect(documentId, ownerCookie)
    await waitFor(() => reopened.text() === 'durable across restarts')
    expect(reopened.text()).toBe('durable across restarts')

    await reopened.close()
  })

  test('the upgrade is refused without a session cookie', async () => {
    const documentId = await freshDocument()
    expect(await upgradeRefused(documentId)).toBe(true)
  })

  test('the upgrade is refused for a non-owner (404, not a room)', async () => {
    const documentId = await freshDocument()
    expect(await upgradeRefused(documentId, strangerCookie)).toBe(true)
  })

  test('the owner’s upgrade is accepted', async () => {
    const documentId = await freshDocument()
    expect(await upgradeRefused(documentId, ownerCookie)).toBe(false)
  })
})
