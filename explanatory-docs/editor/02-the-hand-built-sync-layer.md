# How two people edit the same document at once (the hand-built sync layer)

> Increment: step 2 · M2 — the WebSocket sync server.
> Files: `src/sync/doc-store.ts`, `src/sync/sync-protocol.ts`, `src/sync/doc-room.ts`,
> `src/sync/ws-routes.ts`.

This is the headline of the whole project. Everything else — comments, versioning, notifications — sits on top of it.

The question it answers is the one real-time collaboration question:

    Two people are typing into the same document at the same time.
    How do their keystrokes not clobber each other —
    and how does someone who was offline for a minute catch back up?

Let me follow two people through it.

Mara and Theo both open *Q3 strategy memo*. Mara is at the top fixing a heading. Theo is three paragraphs down rewriting a sentence. Neither should overwrite the other. And when Theo's wifi drops for thirty seconds, he should come back to a document that already has Mara's edits — and Mara should already have his.

---

## The naive version, and exactly how it clobbers

The obvious design: when you change the document, send the new document to the server, and the server tells everyone else.

    Mara's browser:  "the document is now <Mara's whole copy>"
    Theo's browser:  "the document is now <Theo's whole copy>"

Watch what happens when both send within the same second.

Mara's copy has her fixed heading, but Theo's old sentence (she hasn't received his edit yet).

Theo's copy has his rewritten sentence, but Mara's old heading.

The server takes the last one to arrive. Say Theo's.

Mara's heading fix is gone. Silently. She fixed it; the document does not have it.

This is last-write-wins, and it is the default failure of every "just send the whole thing" design. The two edits did not conflict — they were in different paragraphs — but the data model could not represent "both."

---

## The fix is a data structure, not a smarter merge

You could try to merge the two copies with a diff algorithm. People do. It is a swamp — character offsets shift, the same edit looks different from each side, and "whose change wins" has no clean answer.

So we do not send copies of the text at all.

We use a CRDT.

A CRDT is a data structure where concurrent edits merge deterministically.

That is the whole idea. Two people change it independently, you apply both changes in any order, and everyone lands on the *same* final state — with no central referee deciding who wins.

We use **Yjs**, a mature CRDT library. The document is a `Y.Doc`. You do not edit it by replacing text. You make a small change, and Yjs emits a tiny binary **update** — the diff of just that change, with enough structure baked in that it can be merged anywhere.

    Mara fixes the heading
    ↓
    Yjs emits update_M    (a few bytes: "insert these chars, at this logical position")
    Theo rewrites his sentence
    ↓
    Yjs emits update_T

Apply `update_M` then `update_T`, or `update_T` then `update_M` — Yjs guarantees the same result. Both edits survive, because the update encodes *where* the change belongs logically, not "characters 40–58."

That is the property the whole sync layer is built to exploit. Our job is not to merge anything. Our job is to make sure every update reaches every participant, exactly enough times.

---

## The flow of one keystroke

Here is what happens when Mara types, end to end. Watch where each step runs.

    Mara's browser (client)
    ↓  Yjs emits an update
    send it over the WebSocket           (client → server)
    ↓
    server applies it to the room's Y.Doc  (server, in memory)
    ↓
    ├─► append the update to Postgres      (server → DB: durable immediately)
    └─► broadcast it to every OTHER client  (server → Theo, but NOT back to Mara)
    ↓
    Theo's browser applies it              (client)
    ↓
    Theo sees Mara's heading fix

The server is not a participant. It does not have an opinion about the document. It is a **relay with a memory**: it holds the current Y.Doc in RAM so it can answer "what's the state?", it saves every update so nothing is lost, and it forwards updates between the people connected.

One document's relay is a **room** (`doc-room.ts`). Room = one `documentId`. Everyone editing that doc shares one room, one in-memory `Y.Doc`, one set of connections.

---

## The handshake: how a newcomer catches up

When Theo opens the memo, his browser's `Y.Doc` is empty. The server's has the whole document. They need to converge, and Theo might *also* have offline edits the server has never seen. So the catch-up has to go both ways.

Yjs solves this with **state vectors**. A state vector is a compact summary of "how much of each author's changes I already have." Not the content — just the watermarks.

The exchange is two steps, each direction:

    Theo connects
    ↓
    server → Theo:  SyncStep1 = "here is my state vector"
    ↓
    Theo → server:  SyncStep2 = "based on yours, here is everything you're missing from me"
                  + SyncStep1 = "and here is MY state vector"
    ↓
    server → Theo:  SyncStep2 = "based on yours, here is everything you're missing from me"

After that, both sides have everything, and they stay in sync by streaming updates as they happen.

In code, this is almost anticlimactic, because Yjs's `y-protocols` does the vector math. The server just sends the opening message the instant a connection joins:

```ts
// src/sync/doc-room.ts — addConnection
conn.send(encodeSyncStep1(doc))
```

and answers replies by handing the bytes to the protocol:

```ts
// src/sync/doc-room.ts — handleMessage, the 'sync' branch
readSyncMessage(decoder, encoder, doc, conn)
if (encoding.length(encoder) > 1) {
  conn.send(encoding.toUint8Array(encoder))   // length 1 = just the tag = nothing to reply
}
```

This same handshake is what makes **reconnect** work. A returning client is just a newcomer whose `Y.Doc` happens to be half-full. SyncStep1/Step2 figures out the difference and replays exactly the missing updates. There is no special "reconnect" code path — reconnect *is* the handshake. (The integration test proves it: a client leaves, the other keeps editing, the first returns and converges.)

---

## The bug every hand-built relay has: the echo

Here is the trap.

The server receives Mara's update. It broadcasts the update to everyone in the room. If "everyone" includes Mara, she receives her own edit back. Her client applies it, which (naively) emits another update, which it sends to the server, which broadcasts it again...

An echo. Then a loop.

The fix is the **self-echo guard**: broadcast to everyone *except the connection the update came from*.

The mechanism is the transaction *origin*. When the server applies Mara's update, it tags the transaction with Mara's connection as the origin:

```ts
// readSyncMessage(decoder, encoder, doc, conn)  — conn is the origin
```

Then the room's single update handler fans out to everyone but that origin:

```ts
// src/sync/doc-room.ts
doc.on('update', (update, origin) => {
  broadcast(encodeUpdate(update), senderOf(origin))   // senderOf(origin) is skipped
  void appendUpdate(documentId, update)               // and persisted
})
```

There is a second, quieter guard that Yjs gives you for free, and it matters most on reconnect. When Theo comes back and his SyncStep2 replays updates the server *already has*, applying them changes nothing — and **Yjs only fires the `update` event for changes that actually mutate the doc.** So a redundant replay triggers neither a re-broadcast nor a duplicate row in the log. The convergence stays correct and the persistence stays clean without a single line of dedup code on our side.

---

## The door: authorize before the socket opens

A WebSocket starts life as a normal HTTP request that asks to "upgrade" to a socket. That request carries cookies. So the authorization happens *there*, before any socket exists:

```ts
// src/sync/ws-routes.ts — preValidation runs before the upgrade completes
const active = rawToken === undefined ? null : await getSessionUser(rawToken)
if (active === null) {
  return reply.code(401).send({ error: 'not_authenticated' })
}
const document = await getDocumentForOwner({ documentId: parsed.data.id, ownerId: active.userId })
if (document === null) {
  return reply.code(404).send({ error: 'document_not_found' })
}
```

An unauthorized client never gets a live connection — it gets a plain HTTP error on the upgrade. And the rule is the *same* `getDocumentForOwner` the REST routes use, so there is no live room you couldn't also read over REST. (404, not 403, for the same non-oracle reason as the REST layer — see doc 01.)

The five questions for the sync layer:

    Where does it run?        The server holds the room's Y.Doc in memory; clients hold their own copy.
    What shape is the data?   Small binary Yjs updates, and state vectors during the handshake.
    What gets stored?         Every update, appended to Postgres the instant it arrives (doc 01's log).
    What's computed fresh?    The state-vector diff on every (re)connect; the merge on every update.
    What's handed on?         A converged document — everyone's edits, in everyone's copy.

---

## What is honest about this, and what is deferred

**This is single-instance.** One server process holds the room. If we run two processes behind a load balancer, Mara could land on process A and Theo on process B, and B's room never hears A's updates. The fix is cross-instance fan-out: publish each update to a Redis channel, and every process relays what it hears (ignoring its own echoes by an instance id). That is step 9, and it slots into the exact same `doc.on('update')` handler — which is why the handler is where the persistence and broadcast already live.

**The durable write is fire-and-forget.** The update is broadcast and `appendUpdate` is issued, but not awaited before the client moves on. The data-loss window is tiny, not zero. Hardening it into an awaited, acknowledged write is step 8.

**An operational gotcha worth recording:** on Bun, `app.close()` waits forever on an open WebSocket. Graceful shutdown has to `server.closeAllConnections()` first. The tests do it; real connection-draining on redeploy is step 9.

When would you *not* hand-build this? If you do not actually want to learn the sync layer, reach for Hocuspocus or Liveblocks — they give you this and more, debugged. We hand-built it because the sync layer is the thing this project exists to understand. The go/no-go gate at the end of step 2 is exactly the checkpoint where we decide whether the hand-built version earns its keep or gets swapped out.

The whole thing in three beats:

    The CRDT makes concurrent edits mergeable, so no one's keystroke clobbers another's.
    The handshake replays exactly what each connection is missing, so reconnect is just catching up.
    The server is a relay with a memory: forward to everyone else, and write down every word.
