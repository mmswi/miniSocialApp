# How I hand-built real-time collaborative editing (and what's actually inside a CRDT)

> One walkthrough of the whole real-time layer of a collaborative document editor — the merge, the
> transport, the editor, and the persistence — built by hand on Yjs to actually understand it. This is
> five build-log explainers (`01`–`05`) told as one story. Code references are real; every worked CRDT
> example below was run through Yjs before it was written down.

Two people open the same document.

They both start typing into the same paragraph, at the same instant.

Neither has seen the other's keystrokes yet.

And a second later, both screens show the exact same text — with nobody's edit lost, and no central server deciding who won.

That last clause is the hard part.

No referee.

The usual way this gets explained is a pile of vocabulary:

CRDT. Operational transform. State vector. Tombstone. WebSocket upgrade. Snapshot. Compaction.

Which is not an explanation. It is a list of things you are now supposed to understand.

I built the whole real-time layer of a collaborative review tool by hand — on Yjs for the merge itself, but the transport, the reconnect, and the persistence all hand-rolled — specifically so I could explain every piece instead of importing a black box. So here is the box, opened.

One example runs through the entire post. Mara and Theo, editing a document called the *Q3 strategy memo*. Mara is at the top fixing a heading. Theo is three paragraphs down rewriting a sentence. Keep them in mind; every part below is really about them.

The shape of the whole thing, before we start:

    keystroke → a CRDT update → over a WebSocket → to a relay → to everyone else → and onto disk
       (Part 3)    (Part 1)        (Part 2)        (Part 2)        (Part 2)       (Part 4)

We will go in dependency order: first how edits *merge*, then how they *travel*, then how the *editor* hooks in, then how they are *saved*.

---

## Part 1 — The merge: how two keystrokes don't clobber

Start with the naive model, because it is the one everyone reaches for, and watch it break.

Model the document as a string. An edit names a position:

    "insert 'X' at position 5"
    "delete position 3"

Now run Mara and Theo concurrently. The document is `base`. Neither has seen the other:

    Mara:  insert 'X' at position 0
    Theo:  delete position 2          (he means the 's')

Apply Mara's, then Theo's:

    "base"  --insert 'X' at 0-->  "Xbase"
    "Xbase" --delete position 2-->  "Xbse"   ← deleted 'a', not 's'

Theo meant to delete the `s` — index 2 in `base`. But Mara's insert shifted every position right by one, so in `Xbase` index 2 is now `a`. His delete hit the wrong character.

A position is not stable. It means one thing before a concurrent edit and another thing after.

Operational Transformation (OT) patches this by *transforming* one operation against the other — "Theo's index 2 has to become 3, because Mara inserted to its left." It works, and it is notoriously hard to get right; every pair of operation types needs its own transform.

A CRDT — Conflict-free Replicated Data Type — takes the other road. It builds positions that never shift.

### Give every character a permanent name

Stop saying "position 5." Say "the character *between this one and that one*." If characters have permanent names, "between X and Y" means the same thing forever.

Three pieces make that work. This is **YATA** (Yet Another Transformation Approach), the algorithm inside Yjs:

**1. Every character is an *item* with a permanent id** — a pair `(client, clock)`. The `client` is unique per editor (Mara is 1, Theo is 2). The `clock` ticks up as that client creates items. Mara's first character is `(1,0)`, her next `(1,1)`. The id never changes.

**2. The document is a doubly-linked list of items, not a string.** To read the text you *walk* the list and concatenate. No character stores a position number — a character's position is simply where it falls as you walk the list.

    (start) ⇄ [ H (1,0) ] ⇄ [ i (1,1) ] ⇄ (end)
              each item = { id, origin, content, deleted }

**3. Each item remembers its *origin*** — the id of the item to its left at the moment it was inserted. That is its anchor: "I went in right after `(1,0)`." Because ids never change, that anchor is permanent.

Inserting is now just: make an item, point its origin at the left neighbor's id, splice it in. No offsets exist, so nothing can shift out from under anyone.

### The hard case, and the tiebreak that saves it

Empty document. Mara and Theo both type at the very start, same instant:

    Mara inserts 'A'  →  (1,0), origin = (start)
    Theo inserts 'B'  →  (2,0), origin = (start)

Both items have the *same origin*. Both want to be first. Every replica has to pick an order — and it must be the **same** order everywhere, or Mara sees `AB`, Theo sees `BA`, and they have diverged for good.

YATA's rule: items sharing an origin are ordered by **client id** — the same comparison on every machine. Lower id to the left. (The full rule has a few more cases, for inserts whose origins interleave, but they all resolve the same way: a fixed comparison on immutable ids, so every replica agrees.)

So `(1,0) 'A'` lands left of `(2,0) 'B'`, on every replica, because the client ids ride inside the items themselves. I ran exactly this through Yjs:

    apply Mara's update then Theo's  →  "AB"
    apply Theo's update then Mara's  →  "AB"     (same answer, either order)

Both edits survived. The tiebreak only chose their *order*, and chose it identically for everyone. That is the whole trick: **a conflict becomes a deterministic ordering, never a winner and a loser.**

If the two inserts had *different* origins, there is nothing to resolve. Theo inserts `X` before `b` (origin = the start), Mara inserts `Y` after `e` (origin = `e`), and the merge is just `"XbaseY"` (verified) — both survive, because they were never competing for the same anchor.

And notice what is *not* happening: Theo has the higher client id, yet his `X` still lands on the left. No client-id comparison runs here at all — the order falls straight out of the origins. The tiebreak from the last section only fires when two items fight over the *same* origin. This is Mara's heading and Theo's sentence: different places, no conflict.

### Deletes leave a tombstone

One subtlety keeps it all consistent. If you truly spliced a deleted character out of the list, any item anchored to it would lose its origin. So you never remove — you mark the item **deleted**, a **tombstone**, and skip it when rendering.

Document is `XY`. Mara deletes `X`; Theo, concurrently, inserts `Z` right after `X`:

    [ X (deleted) ] ⇄ [ Z ] ⇄ [ Y ]
       skip            keep    keep
    render → "ZY"     (verified)

`X` is invisible but still present as an anchor, so `Z` (origin `X`) lands exactly where `X` was. The tombstone keeps the map intact.

### Why it always converges

Three facts together are the entire guarantee:

- ids are immutable,
- origins point at ids, so they are stable,
- the tiebreak is a fixed function of immutable data (client ids).

So applying the same updates in *any* order builds the same list, which renders the same text. "Yjs updates are commutative" is not magic — it is *every decision is a fixed function of data every replica already has*.

That commutativity is the property everything else in this post leans on.

---

## Part 2 — Getting every keystroke to everyone (the sync layer)

Yjs gives us mergeable updates. It does not move them between people. That is the part I hand-built.

When Mara types, Yjs emits a small binary **update** — the diff of that one change, encoding *where* it belongs logically (an item with an origin), not "characters 40–58." Our job is only to get every update to every participant, exactly enough times.

The flow of one keystroke, watching where each step runs:

    Mara's browser (client)
    ↓  Yjs emits an update
    send it over the WebSocket            (client → server)
    ↓
    server applies it to the room's Y.Doc  (server, in memory)
    ↓
    ├─► append the update to Postgres       (durable immediately — Part 4)
    └─► broadcast to every OTHER client      (server → Theo, NOT back to Mara)
    ↓
    Theo's browser applies it, and sees Mara's edit

The server is **a relay with a memory**. It is not a participant and has no opinion about the document. It holds the current `Y.Doc` for one document in RAM so it can answer "what's the state?", it forwards updates between the people connected, and it writes every update down. One document's relay is a **room**, keyed by document id — everyone editing that document shares one room, one in-memory `Y.Doc`, one set of connections.

### How a newcomer catches up

When Theo opens the memo, his browser's `Y.Doc` is empty and the server's is full — and Theo might *also* have offline edits the server has never seen. So catch-up has to go both ways.

This is what **state vectors** are for. A state vector is a compact summary of "how much of each author's changes I already have" — not the content, just the watermarks: a map of `client → the highest clock I've seen from them`. (Now you can see why Part 1's ids matter — the ids *are* the bookmarks.)

The exchange is two steps, each direction:

    Theo connects
    ↓
    server → Theo:  SyncStep1 = "here is my state vector"
    ↓
    Theo → server:  SyncStep2 = "based on yours, here's everything you're missing from me"
                  + SyncStep1 = "and here is MY state vector"
    ↓
    server → Theo:  SyncStep2 = "based on yours, here's everything you're missing from me"

After that both sides have everything, and they stay in sync by streaming updates as they happen. In code it is almost anticlimactic, because Yjs's `y-protocols` does the vector math — the server just sends the opening message the instant a connection joins:

```ts
// src/sync/doc-room.ts — addConnection
conn.send(encodeSyncStep1(doc))   // "here is my state vector; tell me what you lack"
```

The beautiful part: **reconnect is not a special case.** A returning client is just a newcomer whose `Y.Doc` happens to be half-full. SyncStep1/Step2 figures out the difference and replays exactly the missing updates. There is no separate "reconnect" code path — reconnect *is* the handshake.

### The bug every hand-built relay has: the echo

Here is the trap. The server receives Mara's update and broadcasts it to everyone in the room. If "everyone" includes Mara, she receives her own edit back, applies it, re-emits it, sends it again... an echo, then a loop.

The fix is the **self-echo guard**: broadcast to everyone *except the connection the update came from*. The mechanism is Yjs's transaction *origin* — when the server applies Mara's update it tags the transaction with Mara's connection as the origin, and the room's single update handler fans out to everyone but that origin:

```ts
// src/sync/doc-room.ts
doc.on('update', (update, origin) => {
  broadcast(encodeUpdate(update), senderOf(origin))   // senderOf(origin) is skipped
  void appendUpdate(documentId, update)               // and persisted
})
```

There is a second, quieter guard Yjs gives you for free, and it matters most on reconnect. When Theo comes back and his SyncStep2 replays updates the server *already has*, applying them changes nothing — and **Yjs only fires the `update` event for changes that actually mutate the doc.** So a redundant replay triggers neither a re-broadcast nor a duplicate row in the log. Convergence stays correct and persistence stays clean with zero lines of dedup code.

### Why it is all bytes (lib0, and why we encode and decode)

How does an update actually get *onto* the socket? Three words in the code look like noise — `lib0`, `encoder`, `varUint` — and they are exactly the answer. Start with the data.

Mara types one character. Yjs hands us an update. It is not text. It is a `Uint8Array` — a handful of raw bytes:

    [ 0x01 0x01 0x84 … ]   // a Yjs update; the exact bytes are Yjs's business, not ours

And the same socket also has to carry **presence** — who is in the room, where each cursor is. Two kinds of traffic, one socket.

**The bad version is JSON.** The reflex is `ws.send(JSON.stringify({ type: 'sync', update }))`. It breaks on the first line: the update is binary, and JSON cannot hold raw bytes. You would have to convert it — base64 (bigger, and still opaque text you decode again), or a JSON array of numbers like `[1, 1, 132, 47, 120, 1]`. A 6-byte update just became ~50 bytes of text, on every keystroke, and the receiver has to parse it back into bytes before Yjs can even look at it. You pay to turn bytes into text, send more of it, then turn it back into bytes. For nothing. So we stay in bytes the whole way.

**`lib0` is the toolkit Yjs is built on.** The binary primitives live there — a growable byte buffer, variable-length integers, the matching read/write pair. Yjs uses them internally, and so does `y-protocols`, the helper that gives us `writeSyncStep1`, `writeUpdate`, and `readSyncMessage`. That last fact is the whole reason we use lib0 and nothing else: the update we are wrapping was produced by lib0, and the helpers that read it expect a lib0 buffer. Pick any other serializer and you cannot compose with the very functions doing the sync.

**An encoder is a buffer you append into.** You write typed values in order, then ask for the finished bytes; a decoder is the exact mirror, reading them back *in the same order they were written*:

    createEncoder()              start an empty buffer
    writeVarUint(enc, n)         append a small number
    writeVarUint8Array(enc, b)   append a chunk of bytes, length-prefixed
    toUint8Array(enc)            the finished buffer to send

That ordering *is* the protocol: write tag, then payload; read tag, then payload. Read them out of order and you get garbage, with no error to tell you. A `varUint` (variable-length unsigned integer) costs one byte for a small number — our channel tag is `0` or `1`, where a fixed 32-bit int would spend four to say "0." It is the same encoding Yjs uses internally, so it is already the dialect the buffer speaks.

The framing, end to end:

```ts
// src/sync/sync-protocol.ts
export const encodeUpdate = (update: Uint8Array): Uint8Array => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, SYNC_MESSAGE.sync)   // 1 byte: "channel 0 — a document update"
  writeUpdate(encoder, update)                         // append the payload, length-prefixed
  return encoding.toUint8Array(encoder)
}
```

    Mara's update:   « a few opaque bytes from Yjs »
    ↓  writeVarUint(sync)   prepends the tag byte 0x00
    ↓  writeUpdate          appends the payload, length-prefixed
    framed message:  [ 0x00 | «length» | « the update bytes » ]

The other end reads the tag first, and the tag decides who handles the rest:

    tag 0  →  sync       the document CRDT (the handshake + ongoing updates)
    tag 1  →  awareness  ephemeral presence (who's here, cursor positions)

That one byte is how a single socket multiplexes both channels — the cheapest multiplexer there is. A wrong byte is a silent disaster (presence bytes parsed as a document update), so the tag values live in exactly one place both ends import, never as bare `0`/`1`:

```ts
// src/sync/sync-protocol.ts
export const SYNC_MESSAGE = { sync: 0, awareness: 1 } as const
```

The price of going binary is debuggability — you cannot eyeball a byte buffer in the network tab. We pay it because the payload is *already* binary and we must interoperate with y-protocols; JSON would only add cost and a translation layer.

### The door: authorize before the socket opens

A WebSocket starts life as a normal HTTP request asking to "upgrade" to a socket. That request carries cookies — so authorization happens *there*, before any socket exists:

```ts
// src/sync/ws-routes.ts — preValidation, before the upgrade completes
const active = rawToken === undefined ? null : await getSessionUser(rawToken)
if (active === null) return reply.code(401).send({ error: 'not_authenticated' })
const document = await getDocumentForOwner({ documentId, ownerId: active.userId })
if (document === null) return reply.code(404).send({ error: 'document_not_found' })
```

An unauthorized client never gets a live connection — just a plain HTTP error on the upgrade. And it is the **same** owner check the REST routes use, so "can read this over REST" and "can join its live editing room" can never drift apart.

That `404`, not `403`, is deliberate. A `403` ("forbidden") would confirm the document exists — a stranger now knows there is a real document at that id, they just can't have it. A `404` says nothing: yours or imaginary, you get the same answer. The endpoint is not an existence oracle. (For now the authorization rule is the simplest possible one — you can see a document only if you own it. Teams and roles come later.)

### What is honest about this, and what is deferred

**It is single-instance.** One server process holds each room. Run two processes behind a load balancer and Mara could land on process A, Theo on process B, and B's room never hears A's updates. The fix is cross-instance fan-out: publish each update to a Redis channel and have every process relay what it hears, ignoring its own echoes by an instance id. It slots into the exact same `doc.on('update')` handler — which is why the persistence and broadcast already live there.

**The durable write is fire-and-forget.** The update is broadcast and `appendUpdate` is *issued*, but not awaited before the client moves on. The data-loss window is tiny, not zero — and, as Part 4 shows, it is exactly this fire-and-forget concurrency that makes compaction's bookkeeping subtle. (One operational gotcha worth recording: on Bun, `app.close()` waits forever on an open WebSocket, so graceful shutdown has to close the sockets first.)

---

## Part 3 — From keystroke to pixels (the browser)

That covered the server. The browser is the other end — what happens when Mara presses a key, and how three pieces hand work to each other. Keep them separate; it is easy to blur them:

    TipTap        the editor UI — toolbar behavior, what a heading is, where the cursor blinks
    Yjs           the CRDT — the mergeable document state, emits an "update" on every change
    our provider  the network — carries Yjs updates over the WebSocket to the server and back

TipTap does not know about the network. Yjs does not know about the network. **The provider is the only piece that touches the socket.** That separation is the whole design: swap the provider and nothing else changes.

The glue between TipTap and Yjs is one TipTap extension, `Collaboration`. It replaces TipTap's normal "store the document in the editor" with "store the document in this `Y.Doc`." After that, every edit Mara makes is a Yjs update, automatically:

```ts
// web/src/editor/CollaborativeEditor.tsx
extensions: [
  ...documentExtensions,
  Collaboration.configure({ document: doc }),                        // editor edits → Y.Doc updates
  CollaborationCaret.configure({ provider, user: { name, color } }), // others' cursors from awareness
]
```

The flow of one keystroke, in the browser:

    Mara types a character (TipTap)
    ↓
    Collaboration writes it into the Y.Doc
    ↓
    the Y.Doc emits an "update" event
    ↓
    our provider's doc.on('update') fires → encode as a 'sync' message, ws.send → (server)
    ... meanwhile, a message arrives from the server ...
    ws.onmessage → readSyncMessage applies it to the Y.Doc (origin = remote)
    ↓
    Collaboration sees the Y.Doc change and re-renders the editor
    ↓
    Theo's edit appears in Mara's editor

Notice Mara never re-sends what she just received. The provider applies remote updates with a sentinel origin and skips sending anything tagged with it — the **same self-echo guard as the server**, on the client side:

```ts
// web/src/editor/sync-provider.ts
const remoteOrigin = { remote: true }
const onDocUpdate = (update, origin) => {
  if (origin === remoteOrigin) return   // came FROM the server — don't bounce it back
  send(encodeUpdate(update))            // a genuine local edit — send it up
}
```

### Why the schema has to be shared

Here is the fact that makes this section click, because the name "extensions" hides it.

A **schema** is the grammar of a document: which node types may exist (`paragraph`, `heading`, `bulletList`, `codeBlock`…), which marks (`bold`, `italic`…), and how they nest. A document containing a node the schema doesn't define is invalid — there is nowhere to put it.

In raw ProseMirror you write that grammar by hand. In TipTap you do not: **TipTap derives the schema from your list of extensions.** The array *is* the schema:

```ts
// web/src/editor/document-extensions.ts
export const documentExtensions = [StarterKit.configure({ undoRedo: false })]
```

Each extension contributes a piece of the grammar — `Heading` declares the `heading` node, `Bold` declares the `bold` mark; `StarterKit` bundles ~15 of them. TipTap runs `getSchema(documentExtensions)` and assembles one concrete schema. Same list in, byte-identical schema out. (`undoRedo: false` is the exception that proves the rule — undo/redo is a *behavior* plugin, adding no node or mark type, so it doesn't touch the schema. We turn it off because Yjs owns undo for a shared document.)

Now the trap. A Yjs update names node types **by their schema name**:

    update says:  insert a node of type "heading", level 2, containing the text "Budget"

To apply that, the receiving client hands it to the ProseMirror↔Yjs binding, which looks up `"heading"` in **its own** schema to rebuild the node. So picture two clients with different extension lists:

    Client A's extensions include Heading  →  A's schema knows "heading"
    Client B's extensions do not            →  B's schema has no "heading"

Mara inserts a heading on A. The update reaches B. The binding on B tries to build a `"heading"` node, finds nothing in its schema, and cannot map it — it throws or drops the content. **Desync.** The two ends never disagreed about the *text*; they disagreed about which node types *exist*.

So the extension list lives in **one shared module** with no React and no networking — the single source of truth for "what a document may contain." Every browser editor imports it (so all clients decode each other's updates identically), and a server-side import pipeline imports it too (it builds documents without a browser, and must seed them with the exact same schema, or the first client to open one receives nodes its schema can't read). It must be *shared*, never *copied* — the day someone adds an extension to one copy and not the other, documents silently break.

### Reconnect: the provider survives a bad network

Mara's wifi drops. The socket closes. What should happen? Nothing visible — she keeps typing.

That works because of the layering. Her edits still flow into the `Y.Doc` — Yjs doesn't care the socket is gone — and queue up as document state. Meanwhile the provider notices the close and reconnects with exponential backoff plus jitter:

```ts
// web/src/editor/sync-provider.ts
const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (reconnectAttempts - 1))  // 1s, 2s, 4s … cap 15s
const delay = backoff + backoff * 0.3 * Math.random()                          // jitter: no thundering herd
```

When the socket reopens, the provider sends SyncStep1 again, and the handshake replays exactly what each side missed. Mara's offline edits go up; everything that happened while she was gone comes down. The "reconnect" path is just the "connect" path — the CRDT handshake *is* the catch-up. The jitter matters at scale: if a server restarts and 200 clients all reconnect on the same 1-second timer, they hammer it in lockstep; a random 0–30% spread turns a spike into a smear. (True half-open detection — a socket dead but never firing `close` — needs an application heartbeat, still on the list; today we reconnect on the `close` event, which covers the common cases.)

### The React lifecycle gotcha

There is one non-obvious bug this code is shaped to avoid, and the fix only makes sense once you've seen the broken version.

The instinct is `useMemo`. The `Y.Doc` and provider are expensive and you want them built *once per document*, not rebuilt on every render — that is exactly what `useMemo` is for. You memoize them, and tear them down in an effect cleanup:

```tsx
// THE BROKEN VERSION — do not ship this
const doc = useMemo(() => new Y.Doc(), [documentId])
const provider = useMemo(
  () => createSyncProvider({ documentId, doc, onStatusChange: setStatus }),
  [documentId, doc],
)

useEffect(() => {
  // ◄── THIS returned function is the cleanup. It tears down BOTH memoized resources:
  return () => {
    provider.destroy()   // closes the WebSocket and stops syncing  → dead socket
    doc.destroy()        // tears down the CRDT state TipTap is bound to → dead document
  }
}, [provider, doc])
```

Both lines matter equally — neither resource is rebuilt after the cycle below, so the editor ends up bound to a dead socket *and* a dead `Y.Doc`. (If anything `doc.destroy()` is the worse one: a dead socket only stops network sync, but a destroyed `Y.Doc` is the editor's whole data model, gone.)

It reads correctly. It even works in production. It is broken in development, and the cause is **React StrictMode**.

In dev, StrictMode deliberately mounts every component, immediately unmounts it, then mounts it again — once — to surface effects that don't survive a remount. The subtlety is *what* it does across that cycle: it re-runs your **effects** (cleanup, then setup again), but it does **not** re-run the component's `useMemo` factories. There is no fresh render in between, and the deps (`documentId`) haven't changed — so the memo keeps handing back the instance it already built.

Trace it:

    1. Mount
       useMemo builds doc D1 + provider P1        (P1 opens the WebSocket)
       effect setup runs                           (no-op — the effect is only a cleanup)
    2. Simulated unmount
       effect CLEANUP runs → provider.destroy() AND doc.destroy()    ◄── both torn down here
                                                  (P1's socket closed, D1's CRDT state gone)
    3. Simulated remount
       NO re-render, deps unchanged →
         useMemo returns the SAME D1, P1           (the factory does NOT run again)
       effect setup runs again                      (still a no-op)
    4. The component now holds D1 and P1 — both destroyed in step 2, neither rebuilt.
       Dead socket AND dead document. The editor renders against a corpse.

The bug is a **split between creation and destruction**. Creation ran *once*, in the memo, and survives the remount. Destruction runs on *every* unmount, in the effect cleanup. One StrictMode cycle gives you one destroy and zero rebuilds — and they are now out of sync.

The fix is to put creation and destruction in the **same place** — the effect — so every teardown is paired with a fresh build:

```tsx
// web/src/pages/DocumentEditorPage.tsx — the real version
useEffect(() => {
  const doc = new Y.Doc()
  const provider = createSyncProvider({ documentId, doc, onStatusChange: setStatus })
  setSession({ doc, provider })            // hand the fresh pair to render
  return () => {
    provider.destroy()
    doc.destroy()
    setSession(null)
  }
}, [documentId])
```

Now the StrictMode remount re-runs the effect setup, which **builds a fresh D2 + P2** — so every destroy is matched by a build, and the editor renders against a live pair. In production, where the double-mount doesn't happen, the effect just runs once. (Because the pair is built *inside* the effect, after the first render, the first render has no provider yet — which is why it lives in `session` state with a `Loading editor…` fallback.)

---

## Part 4 — Never losing a word (durable state + compaction)

The document's live state is a CRDT in memory. Memory is gone the instant the process restarts. So how do we save it without saving too much, or losing the last few seconds of typing?

### Where the content actually lives

Here is the surprising part. The `documents` row does **not** hold the text of the memo:

```ts
// src/db/schema.ts
export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Untitled document'),
  snapshot: bytea('snapshot'),            // <- the content, but NULL right now
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

When Mara creates the memo, `snapshot` is `NULL`. The document is real — it has an id, a title, an owner — it just has no content yet. The content is the CRDT, and it is not written here the way you write a string to a column; it gets *seeded* the first time someone opens the memo and types. So the interesting design is not the columns. It is *how the content gets saved* once it exists.

### The naive save loses work

The obvious way to persist an editor: every time the document changes, write the whole thing back.

    Mara types a word  →  serialize the entire document  →  UPDATE documents SET snapshot = <whole doc>

Bad two ways. It rewrites the *entire* document on every keystroke — a 40-page memo, re-serialized because she fixed a typo. So people debounce it: "only save every 2 seconds." Which trades one problem for a worse one. Picture the process dying at second 1.9 — a redeploy, a crash, a reboot. The last ~2 seconds of everyone's typing are gone, because they only ever lived in memory, waiting for a timer that never fired. For a tool whose whole point is collaborative editing, silently dropping the last edit is the cardinal sin.

### Two tiers: append now, fold later

A CRDT does not force you to choose between "save everything" and "save rarely." Every change produces a small binary **update** — the diff of just that change. So we keep two tiers.

**Tier one — the append-only log.** The instant the sync server receives an update, it appends it as a row. Durable *now*, no timer:

```ts
// src/db/schema.ts
export const documentUpdates = pgTable('document_updates', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  update: bytea('update').notNull(),     // one Yjs update — the diff of a single change
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

**Tier two — the snapshot.** A background worker periodically **folds** the log into one compacted blob. To *fold* is to take the snapshot plus the loose update rows, replay them into one `Y.Doc`, re-encode that single state, write it back as the new snapshot, and delete the rows it folded — many small diffs collapse into one. Loading a document back is the same idea in reverse:

    snapshot  +  replay every update row still in the log  =  the current document

The append is what kills the data-loss window: the change is on disk before the editor repaints. The snapshot is just an optimization on top, so the log never has to be replayed from the beginning of time.

### The log only grows

Why bother folding at all? Because the append log has a second cost. Each keystroke is a row, and the log only grows:

    day 1:   snapshot = ∅   +   replay 200 rows      → fast
    day 7:   snapshot = ∅   +   replay 50,000 rows   → slow, and getting slower

The append bought durability and charges for it in load time. Nothing trims the log, so the bill grows forever. **Compaction** is the housekeeping that pays it: every so often, fold the pile of little updates into one snapshot blob and delete the rows it merged. After a fold, loading reads one blob and replays nothing.

It helps to say what compaction is **not**. It is not required for correctness — the append already made every edit durable; if the worker never ran, nothing would be lost, loads would just keep getting slower. It is not on the editing path — Mara never waits for it; it runs in a separate worker process. And it is not a debounce — the durable write already happened; compaction only *consolidates* what is already on disk.

### The fold, in code

```ts
// src/sync/compaction.ts — compactDocument, all inside one transaction
const pending = await tx
  .select({ seq: documentUpdatesTable.seq, update: documentUpdatesTable.update })
  .from(documentUpdatesTable)
  .where(eq(documentUpdatesTable.documentId, documentId))
  .orderBy(asc(documentUpdatesTable.seq))

const doc = new Y.Doc()
if (meta.snapshot !== null) Y.applyUpdate(doc, meta.snapshot)   // start from the old snapshot
for (const row of pending) Y.applyUpdate(doc, row.update)       // replay the loose updates
const foldedSnapshot = Y.encodeStateAsUpdate(doc)              // re-encode: many → one

await tx.update(documentsTable).set({ snapshot: foldedSnapshot }).where(/* this doc */)
await tx.delete(documentUpdatesTable).where(/* exactly the rows we just folded */)
```

### When it runs: the sweep

Folding on every keystroke would be absurd — re-encoding a 40-page memo because Mara typed one letter. Never folding makes loads crawl. So we fold on a schedule, and only the documents that need it. A repeatable job fires every 60 seconds; each tick is one **sweep**: find the documents whose un-folded log has crossed a threshold, and fold each.

```ts
// src/sync/compaction.ts
export const COMPACTION_THRESHOLD = 200   // fold a document once it has ≥ 200 loose updates
```

Because folded rows are deleted, the rows left in `document_updates` *are* the un-folded tail — so a plain `COUNT` per document is exactly "how far behind is this one." The threshold is a tuning knob, not a correctness one: fold more often for a smaller tail and cheaper loads at the cost of more background work, or less often for the reverse. Durability does not depend on it at all.

Now the two subtleties — both real bugs I had to design around.

### The watermark that loses edits

How does a fold know *which* rows it folded, so it deletes those and not others? The tempting answer is a high-water mark: store a number `snapshotThrough = N` meaning "the snapshot folds in every update through seq N." Then load replays `seq > N`, and a fold deletes `seq <= N`. One number, clean — and it even *looks* race-proof, since a new append during a fold gets a seq above N.

It loses edits. `seq` is a `bigserial` — Postgres hands out the number at the moment of **insert**, but a row stays invisible to everyone else until its transaction **commits**, and commits do not finish in the order the numbers were handed out. The appends are fire-and-forget, so several are in flight at once:

    1. Append X grabs seq = 11 — has NOT committed yet
    2. Append Y grabs seq = 12 — commits fast
    3. Fold reads "seq > snapshotThrough" → sees 12, NOT 11 (uncommitted = invisible). Folds it, sets N = 12
    4. Fold deletes seq <= 12. Row 11 is still invisible, so it survives the delete
    5. X finally commits seq = 11
    6. Next load replays seq > 12 → row 11 is never replayed

Row 11 is gone — Mara's edit, dropped silently, by the exact layer whose whole job is to never drop one. The bug hides inside the word *watermark*: `seq <= N` does **not** mean "I have seen everything up to N." A counter that hands out numbers before transactions commit cannot promise that.

### The fix: delete what you fold, replay what remains

Throw the watermark away. Two rules, and the loss becomes impossible.

**Delete exactly the rows you folded.** The fold reads the loose rows, folds the ones it can see, and remembers their exact `seq` list. It deletes *that list* — never `seq <= max`:

```ts
// src/sync/compaction.ts
const foldedSeqs = pending.map((row) => row.seq)
await tx.delete(documentUpdatesTable).where(
  and(eq(documentUpdatesTable.documentId, documentId), inArray(documentUpdatesTable.seq, foldedSeqs)),
)
```

A row that commits *after* the read is simply not in the list, so it is never deleted.

**Load replays every remaining row** — no `seq > N` filter. Folded rows are gone, so whatever is still in `document_updates` *is* the un-folded tail, a late-committing row 11 included. Run the race again: row 11 commits late, the fold never deleted it (not in the list), and the next load replays every remaining row. Commutativity (Part 1) means replay order doesn't matter, so row 11 lands correctly on top of the snapshot. Nothing lost. "Which rows did I fold?" is answered by holding the actual list for one transaction, not by trusting a single stored number.

### One fold at a time, without blocking writers

One race is left. Two sweeps fold the *same* document at the same moment:

    Sweep A reads loose rows {1, 2, 3}
    Sweep B reads loose rows {1, 2, 3, 4}
    B writes its snapshot (covers 1–4), deletes rows 1–4
    A writes ITS snapshot (covers only 1–3)   ← clobbers B's, and row 4 is already gone

So two folds of one document must take turns. The tool is a **lock** — a way for one operation to say "I'm using this, wait for me." The catch is that the *obvious* lock breaks the thing we care about most, and the cleanest way to see why is an analogy.

Picture the `documents` row as a **house**. It has an **address** — its id, the permanent identity other things point at — and **contents** — the snapshot, the stuff inside that changes. A **fold** rewrites the *contents*; it never changes the address. An **append** barely touches the house at all: it drops a row in the log that points back at the house by its address (a *foreign key*), and before it attaches, the database places a light hold meaning *"don't demolish this or change its address while I'm linking to it."* Many appends can hold that at once.

The reflex lock for the fold grabs the house *exclusively* — a sign reading **"Renovation in progress. Keep out. The address itself might change."** That makes folds take turns, yes, but now no append can attach, because every append needs the address to stay put. Every keystroke-save stalls behind a *background cleanup job* — exactly backwards.

But a fold never changes the address, only the contents. So it can hang a more honest sign: **"Rearranging the contents. The address stays exactly the same."** Now a second fold still can't start (two renovators rewriting the same contents would collide), but appends keep flowing — they only ever needed the address to stay put.

Those three signs are real Postgres **row-level locks**, requested by adding a `FOR …` clause to a read:

    FOR KEY SHARE       "don't change this row's identity"       ← the append's automatic hold (from the foreign key)
    FOR NO KEY UPDATE   "I'll change its contents, not its id"   ← the fold
    FOR UPDATE          "I might change anything about it"       ← the greedy one we avoid

`FOR NO KEY UPDATE` conflicts with *itself* (two folds serialize) but **not** with `FOR KEY SHARE` (appends sail past). In code, that is one method on the locking read:

```ts
// src/sync/compaction.ts
const [meta] = await tx
  .select({ snapshot: documentsTable.snapshot })
  .from(documentsTable)
  .where(eq(documentsTable.id, documentId))
  .for('no key update')                      //  → SELECT … FOR NO KEY UPDATE
```

The append's `FOR KEY SHARE` you never write — Postgres takes it automatically because `document_updates.document_id` is a foreign key referencing `documents(id)`, so inserting a child row holds the parent's identity still until the link is made. The lock lasts until the transaction's `COMMIT`. The whole point in one line: **the only thing a fold ever waits on — or makes anything wait on — is another fold.**

---

## It works (the proof)

Two layers of evidence, because "it should converge" is not "it converges."

**Automated** — 16 integration tests against the real ws server and real Postgres: bidirectional convergence, same-tick concurrent merge, reconnect → resync → replay, durable cold-reload from Postgres, auth-on-upgrade, and compaction (including a *staged commit-reordering race* that proves the watermark fix).

**Live, in two browser tabs** on one document, the real editor:

- type in Tab A → it renders in Tab B, and back — the full `TipTap ↔ Yjs ↔ provider ↔ ws` round trip
- each tab shows the other's named caret (presence)
- reload a tab → content returns and reconnects
- I pushed the document to **247 updates**; ~30 seconds later the background sweep folded it live — 247 rows → 0, snapshot written (442 bytes) — exactly the two-tier persistence, end to end
- zero app-level console errors

It is roughly 600 lines I own and have debugged.

---

## What this can't do yet: a second server

One limitation is worth stating plainly, because it is the first thing that breaks under real load.

Everything above assumes **one server process**. Each room — the in-memory `Y.Doc` for a document — lives in that single process's heap. As long as everyone editing a document connects to the same process, they share the same room, and real-time sync just works.

Now scale out. Put two server processes behind a load balancer. Mara opens the memo and lands on process A; Theo opens the same memo and lands on process B. Each process builds its *own* room for that document — its own in-memory `Y.Doc`, its own set of connections — and neither knows the other exists.

    Mara ──ws──► process A ──► room (Y.Doc) for the memo
    Theo ──ws──► process B ──► a DIFFERENT room (Y.Doc) for the same memo

They are both "connected" and editing the same document, but their keystrokes never reach each other live. A's room broadcasts only to A's connections; B's only to B's. Mara would see Theo's edits only later — on a reload, rebuilt from the shared Postgres log they both append to. For a tool whose entire promise is *live* collaboration, that is a real hole.

The fix is a later step: **cross-instance fan-out over Redis pub/sub.** Whenever a room produces an update, its process publishes that update to a Redis channel keyed by the document id — and every process subscribed to that channel relays what it hears into its own local room, ignoring its own echoes by an instance id (the self-echo guard, one level up). Redis becomes the bus that makes N separate rooms behave as one.

The shape of the code makes this an addition, not a rewrite: it slots into the exact same `doc.on('update')` handler where broadcast-and-persist already live —

    doc.on('update'):
      ├─► broadcast to this process's own connections   (today)
      ├─► append to Postgres                             (today)
      └─► publish to the Redis channel                   (the later step)

— and the inbound side subscribes to that channel and feeds what it receives back through the same apply-and-broadcast path. Until that lands, the honest statement is this: the implementation is **single-instance**. It is correct and complete for one process, and incomplete the moment you run two.

---

## When I'd reach for a library instead

I hand-built this to *understand* it, and that goal is the whole justification. If you don't want to learn the sync layer, Hocuspocus or Liveblocks give you the relay, reconnect, and awareness already debugged — and you should use them.

I'd reach for one the moment the parts I *deferred* turn expensive: multi-instance fan-out (one process holds each room today; sharing rooms across processes is a Redis pub/sub layer), acknowledged-not-fire-and-forget persistence, a heartbeat for half-open sockets. None of those are hard to see coming; none change the fact that, for learning, hand-rolling was the point.

The whole system in three beats:

    The CRDT gives every character a permanent name, so concurrent edits merge with no referee.
    The relay forwards every update to everyone else and writes down every word.
    The append log saves it the instant it happens; compaction folds it so loading stays cheap.

And the property that ties all three together is the same one: apply the updates in any order, and everyone lands on the same document.
