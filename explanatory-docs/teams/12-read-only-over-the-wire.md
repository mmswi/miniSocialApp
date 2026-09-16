# Read-only that actually holds — dropping a viewer's edits at the socket

> Increment: step 4 · M6 — websocket read-only sync (per-message write gate).
> Files: `src/sync/doc-room.ts` (`handleMessage`, `SyncConnection.canEditDoc`),
> `src/sync/ws-routes.ts` (stash access → `canEditDoc`).

[Doc 11](./11-rest-ws-parity-the-resolver-gates-the-room.md) ended by naming a gap out loud: the websocket gate decided who could **join** the room, not what they could **do** once inside. A read-level member joined to receive content — correct — but could then send edits, and the server applied them. This doc closes that gap. It's the difference between "read-only in the UI" and "read-only for real."

The example, from [doc 10](./10-effective-access-max-level-in-ts.md):

    Cass is in Legal (read).
    "Q3 Launch Plan" is shared into Legal.
    Cass opens the editor. She should SEE every edit, and make NONE.

---

## Why the client can't be trusted to enforce this

The obvious fix is on the client: if Cass has read access, mount the editor with `editable: false`. [M9](./13-the-sharing-ui-and-the-read-only-editor.md) does exactly that, and it's good UX — Cass sees a "View only" chip instead of a cursor.

But that is **convenience, not security**. Here's the bad version, the one where the client is the only guard:

    Cass's browser has read access → editor is editable: false → she can't type.

    ...but the websocket is still open. Anyone can open a devtools console, or a
    script, and send a raw update frame over that socket. The server, trusting
    the join gate alone, applies it. Read-only bypassed.

The socket is a direct line to the document state. If the only thing stopping a write is the client choosing not to send one, then read-only is a suggestion. The enforcement has to live where the bytes actually arrive: the server.

## Two gates, one access decision

So access control over the websocket is now **two** gates, and both read the *same* effective access [the resolver](./10-effective-access-max-level-in-ts.md) computes:

    JOIN gate  (ws-routes.ts, M5) → may you open the room at all?      owner or any shared-team member
    WRITE gate (doc-room.ts,  M6) → may this message change the doc?   owner / write / delete only

Cass clears the join gate (she's a Legal member) and fails the write gate (Legal is `read`). She's in the room, receiving, but her edits die at the door.

The write flag is resolved **once**, at the upgrade, and carried on the connection:

```ts
// src/sync/ws-routes.ts — preValidation already resolved access; stash it, then:
const canEditDoc = req.documentAccess !== undefined && canWriteDocument(req.documentAccess)
const connection: SyncConnection = { canEditDoc, send: (data) => { /* ... */ } }
```

`canWriteDocument` is the *same* predicate PATCH uses ([doc 10](./10-effective-access-max-level-in-ts.md)) — owner/write/delete → true, read → false. One definition of "may write," shared by REST and realtime, so they can't drift apart. And `canEditDoc` is a **required** field on `SyncConnection` — no default. A default would be a trap: forget to set it and every connection silently becomes writable. Making it required means the compiler refuses to build a connection that hasn't decided.

## The gate itself: peek, don't consume

A websocket message on the `sync` channel isn't one kind of thing. It's three, distinguished by an inner byte the y-protocols library writes:

    messageYjsSyncStep1 = 0   "here's my state vector, what am I missing?"   ← a REQUEST for content
    messageYjsSyncStep2 = 1   "here are the updates you were missing"        ← carries edits
    messageYjsUpdate    = 2   "here's a new change"                          ← carries edits

Only SyncStep1 is safe for a reader — it's Cass *asking* for content, which the server answers with a SyncStep2 full of the document. Step2 and Update both *carry* edits, so a reader must not be allowed to send them.

The gate reads that inner byte before deciding:

```ts
// src/sync/doc-room.ts — handleMessage, the sync branch
const innerType = decoding.peekVarUint(decoder)
if (!conn.canEditDoc && innerType !== messageYjsSyncStep1) {
  if (innerType === messageYjsUpdate) {
    console.warn(`[sync] dropped a read-only connection's update for ${documentId}`)
  }
  return                      // dropped — never reaches readSyncMessage
}
// ...allowed: readSyncMessage applies/answers as before
```

The one subtlety is `peekVarUint` versus `readVarUint`. `readVarUint` would **consume** the byte, advancing the decoder — and then `readSyncMessage` below would start one byte too late and misread the whole message. `peekVarUint` reads the value and leaves the cursor where it was, so on the allowed path the message is still whole for `readSyncMessage`. Peek to decide; let the real reader consume.

## Three deliberate choices in that gate

**SyncStep1 stays allowed — that's how Cass receives.** Drop it too and a reader could never ask "what am I missing?", so she'd never get the document. Reading *requires* sending SyncStep1. The gate blocks the two edit-carrying types and nothing else.

**We drop, we don't disconnect.** A rejected write doesn't close Cass's socket. She's *supposed* to hold an open connection — that's how she keeps receiving Ben's and Ana's edits live. Closing on a stray write would kick every viewer off the instant their client misbehaved, and their client would immediately reconnect: a reconnect storm for nothing. Drop the message, keep the pipe.

**Awareness is never blocked.** Cursors and presence ride a different channel (`SYNC_MESSAGE.awareness`), and that's not a document mutation — Cass's cursor showing up for everyone is fine, even welcome. Only the `sync` channel's edit messages are gated. (This is also the seam the future commenter tier will need: a reader who can leave comments but not edit.)

Notice too that only an **Update** gets logged, not a dropped Step2. A fresh reader's handshake naturally replies to the server's SyncStep1 with a (usually empty) Step2 — that's normal protocol chatter, not an attack, so logging it would be noise. An *Update* from a read-only connection means something worth seeing: either a forged frame or a UI that failed to go read-only.

---

## What M6 does NOT do (the honest edge)

Access is resolved **once, at join**. If Ana demotes Cass from write to read *while Cass's socket is open*, that live socket keeps its old `canEditDoc` until Cass reconnects. The gate re-resolves on the next upgrade, not mid-connection.

For this project that's an accepted limitation, written down rather than hidden. The clean fix is a `closeConnectionsForUser` that kicks a user's live sockets when their access changes, forcing a re-resolve on reconnect — a follow-up, not part of M6. In practice the window is small and the failure is mild (a just-demoted user keeps write access for seconds, until they refresh).

---

The five questions for this milestone:

**Where does this run?**

The server, inside `doc-room.ts`'s `handleMessage`, on every inbound `sync` message — after the join gate, before the update is applied.

**What shape is the data?**

A binary frame: an outer channel tag, then (for sync) an inner y-protocols type byte, then the payload. The gate reads the inner byte and decides.

**What gets stored?**

For a read-only connection's edit: nothing. That's the whole point — the update is neither applied to the in-memory doc, nor broadcast, nor appended to the log. It evaporates.

**What's computed fresh?**

The write decision is *not* recomputed per message — `canEditDoc` is resolved once at join and read on each message. What's fresh per message is only the cheap inner-type peek.

**What's handed on?**

A document room where every connection can read, but only writers can write — enforced at the server, not trusted to the client. The realtime layer now matches the REST layer: read access is read-*only*, both over HTTP and over the wire.

---

The whole idea in three beats:

    Read-only in the UI is convenience; the socket is a direct line to the doc, so enforcement must live at the server.
    Peek the inner sync type without consuming it: a reader may send SyncStep1 (to RECEIVE), never Step2 or Update (which WRITE).
    Drop the message, don't close the socket — the reader keeps receiving — and re-resolve on reconnect, the one edge M6 leaves for later.

This completes the teams **backend**: sharing, effective access, and read-only realtime all agree on one access decision. Next: [doc 13](./13-the-sharing-ui-and-the-read-only-editor.md) puts a face on all of it — the share panel that assigns a doc to a team, and the editor that shows "View only" when the access says read.
