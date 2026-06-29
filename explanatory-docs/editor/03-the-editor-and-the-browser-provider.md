# How a keystroke in the browser becomes a synced edit (the client half)

> Increment: step 2 · M3 — the TipTap editor + the hand-built client provider.
> Files: `web/src/editor/document-extensions.ts`, `web/src/editor/sync-provider.ts`,
> `web/src/editor/CollaborativeEditor.tsx`, `web/src/pages/DocumentEditorPage.tsx`.

Doc 02 built the server: a relay that holds the document's CRDT and forwards updates. This doc is the other end — what happens in the browser when Mara types, and how three pieces (TipTap, Yjs, our provider) hand work to each other.

The question:

    Mara presses a key in a rich-text editor.
    How does that become a Yjs update, travel to the server, and show up in Theo's editor —
    and how does the editor survive Mara's wifi dropping for ten seconds?

---

## Three pieces, and who does what

It is easy to blur these together. Keep them separate.

    TipTap        the editor UI — toolbar behavior, what a heading is, where the cursor blinks
    Yjs           the CRDT — the mergeable document state, emits an "update" on every change
    our provider  the network — carries Yjs updates over the WebSocket to the server and back

TipTap does not know about the network. Yjs does not know about the network. **The provider is the only piece that touches the socket.** That separation is the whole design: swap the provider and nothing else changes.

The glue between TipTap and Yjs is one TipTap extension, `Collaboration`. It replaces TipTap's normal "store the document in the editor" with "store the document in this Y.Doc." After that, every edit Mara makes is a Yjs update, automatically.

```ts
// web/src/editor/CollaborativeEditor.tsx
extensions: [
  ...documentExtensions,
  Collaboration.configure({ document: doc }),                 // editor edits → Y.Doc updates
  CollaborationCaret.configure({ provider, user: { name, color } }),  // others' cursors from awareness
]
```

---

## The flow of one keystroke, in the browser

    Mara types a character (TipTap)
    ↓
    Collaboration writes it into the Y.Doc
    ↓
    the Y.Doc emits an "update" event
    ↓
    our provider's doc.on('update') fires
    ↓
    encode it as a 'sync' message, ws.send  → (server, doc 02)
    ... meanwhile, a message arrives from the server ...
    ws.onmessage → readSyncMessage applies it to the Y.Doc (origin = remote)
    ↓
    Collaboration sees the Y.Doc change and re-renders the editor
    ↓
    Theo's edit appears in Mara's editor

Notice Mara never re-sends what she just received. The provider applies remote updates with a sentinel origin, and skips sending anything tagged with it — the **same self-echo guard as the server**, on the client side:

```ts
// web/src/editor/sync-provider.ts
const remoteOrigin = { remote: true }
// applying server data:  readSyncMessage(decoder, encoder, doc, remoteOrigin)
const onDocUpdate = (update, origin) => {
  if (origin === remoteOrigin) return   // came FROM the server — don't bounce it back
  send(encodeUpdate(update))            // a genuine local edit — send it up
}
```

---

## Why the schema has to be shared

First, the fact that makes this whole section click — because the name "extensions" hides it.

A **schema** is the grammar of a document: which node types may exist (`paragraph`, `heading`, `bulletList`, `codeBlock`…), which marks (`bold`, `italic`, `code`…), and how they nest. A document containing a node the schema doesn't define is invalid — there is nowhere to put it.

In raw ProseMirror you write that grammar by hand.

In TipTap you do not. **TipTap derives the schema from your list of extensions.**

That is the link. The array *is* the schema:

```ts
// web/src/editor/document-extensions.ts
export const documentExtensions = [StarterKit.configure({ undoRedo: false })]
```

Each extension contributes a piece of the grammar — the `Heading` extension declares the `heading` node, `Bold` declares the `bold` mark. `StarterKit` is a bundle of ~15 of them. TipTap runs `getSchema(documentExtensions)` and assembles one concrete schema:

    [StarterKit, …]  ──getSchema()──►  ProseMirror Schema  ──►  the allowed document shape

Same list in, byte-identical schema out. So `documentExtensions` reads as: "the node and mark types a document may contain are whatever these extensions declare."

(`undoRedo: false` is the exception that proves the rule. Undo/redo is a *behavior* plugin — it adds no node or mark type, so it does not touch the schema. We turn it off because Yjs owns undo for a shared document, not because it changes the grammar. Only the node/mark extensions shape the schema.)

### Why Yjs forces every end to use the same one

Now the trap. A Yjs update does not carry "characters 40–58." It carries structure, and it names node types **by their schema name**:

    update says:  insert a node of type "heading", level 2, containing the text "Budget"

To apply that, the receiving client hands it to the ProseMirror↔Yjs binding — in TipTap v3 that's **`@tiptap/y-tiptap`** (TipTap's own fork of the older standalone `y-prosemirror`), pulled in transitively by `@tiptap/extension-collaboration`; we never depend on it directly. The binding looks up `"heading"` in **its own** schema to rebuild the node. So picture two clients with different extension lists:

    Client A's extensions include Heading  →  A's schema knows "heading"
    Client B's extensions do not            →  B's schema has no "heading"

Mara edits on A and inserts a heading. The update reaches B. The binding on B tries to build a `"heading"` node, finds nothing in B's schema, and cannot map it — it throws or drops the content. **Desync.**

The two ends never disagreed about the *text*. They disagreed about which node types *exist*. That is the structure mismatch — and the fix is simply that both ends derive their schema from the **same** extension list.

### So it lives in one module

Two places need that exact schema, which is why `document-extensions.ts` stands alone with no React and no networking:

1. **Every browser editor** — so all clients decode each other's updates identically.
2. **Step 3's PDF-import worker** — it builds a document *server-side* (no browser) and converts it to a Y.Doc with `@tiptap/y-tiptap`'s `prosemirrorToYDoc(pmDoc, …)`, which needs `getSchema(documentExtensions)`. Seed it with even a slightly different list and the first client to open the doc receives nodes its schema can't read — desync on load. (It must use the *same* binding the client does — `@tiptap/y-tiptap`, not standalone `y-prosemirror` — since the two forks can encode the same document into subtly different Yjs structures.)

If those were two copies, the day someone adds an extension to one and not the other, documents silently break. So it is one importable module — the single source of truth for "what a document may contain" — that the client and the worker both pull from. It must be *shared*, never *copied*.

---

## Reconnect: the provider is the part that survives a bad network

Mara's wifi drops. The socket closes. What should happen?

Nothing visible. She keeps typing.

That works because of the layering. Her edits still flow into the Y.Doc — Yjs does not care that the socket is gone. They queue up as document state. Meanwhile the provider notices the close and reconnects:

```ts
// web/src/editor/sync-provider.ts — exponential backoff with jitter
const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (reconnectAttempts - 1))  // 1s, 2s, 4s … cap 15s
const delay = backoff + backoff * 0.3 * Math.random()                          // jitter: no thundering herd
reconnectTimer = setTimeout(connect, delay)
```

When the socket reopens, the provider sends SyncStep1 again — and the handshake from doc 02 replays exactly what each side missed. Mara's offline edits go up; everything that happened while she was gone comes down. The "reconnect" path is just the "connect" path; there is no separate catch-up logic, because the CRDT handshake *is* the catch-up.

The jitter matters at scale: if the server restarts and 200 clients all reconnect on the same 1-second timer, they hammer it in lockstep. A random 0–30% spread turns a spike into a smear.

(True half-open detection — a socket that's dead but never fired `close` — needs an application heartbeat. That's listed for step 8; today we reconnect on the `close` event, which covers the common cases.)

---

## The React lifecycle gotcha

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

Both lines matter equally — neither resource is rebuilt after the cycle below, so the editor ends up bound to a dead socket *and* a dead `Y.Doc`. (If anything `doc.destroy()` is the worse one: a dead socket only stops network sync, but a destroyed `Y.Doc` is the editor's whole data model, gone.) The arrow just marks where the teardown lives.

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

Now run the *same* StrictMode cycle:

    1. Mount:             effect setup → build D1 + P1, setSession(D1/P1)
    2. Simulated unmount: cleanup → destroy D1 + P1, setSession(null)
    3. Simulated remount: effect setup AGAIN → build a FRESH D2 + P2, setSession(D2/P2)

Every cleanup is matched by a build, because both live in the effect that StrictMode re-runs. Step 3 hands the editor a brand-new, live pair. In production, where the double-mount doesn't happen, the effect just runs once.

One consequence falls out of this: because the pair is built *inside* the effect (after the first render, not during it), the first render has no provider yet. That is why the pair lives in `session` state with a `Loading editor…` fallback — render waits for the effect to hand it a live pair, rather than `useMemo` producing one mid-render.

The five questions for the client half:

    Where does it run?        The browser. TipTap renders, Yjs holds state, the provider owns the socket.
    What shape is the data?   Yjs updates (binary) out and in; awareness messages for cursors.
    What gets stored?         Nothing client-side persists — the Y.Doc is in memory; the server is the disk.
    What's computed fresh?    The editor re-renders from the Y.Doc on every change, local or remote.
    What's handed on?         Local edits up to the server; remote edits down into the editor.

---

## When you would not build the provider by hand

If you reach for Hocuspocus or Liveblocks, you get this provider — reconnect, awareness, the lot — already written and battle-tested, and you write none of `sync-provider.ts`. We wrote it because the provider is half of the sync layer this project exists to understand, and because a 120-line provider we understand fully beats a dependency we treat as magic. That tradeoff is exactly what the end-of-step-2 go/no-go gate re-examines.

The whole thing in three beats:

    TipTap turns keystrokes into Yjs updates, and never touches the network.
    The provider carries those updates over the socket, and reconnects when the network dies.
    The shared schema keeps both ends describing the same document, so the binding never desyncs.
