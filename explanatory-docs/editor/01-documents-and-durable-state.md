# How a document gets a durable home (and why the shape is two-tier)

> Increment: step 2 · M1 — the documents data model + owner-scoped REST.
> Files: `src/db/schema.ts` (`documents`, `document_updates`), `src/documents/documents.ts`,
> `src/documents/routes.ts`.

Step 2 is the multiplayer editor. Before two people can co-edit a document, the document needs a place to live — and a place to be saved that does not lose anyone's typing.

This milestone builds that place. Not the editing yet. The *home*.

There is one real question underneath it:

    A document's live state is a CRDT held in memory by the sync server.
    Memory is gone the instant the process restarts.
    So how do we save it without either saving too much, or losing the last few seconds of work?

Let me follow one document the whole way.

Mara clicks **New document**. It is called *Q3 strategy memo*. Trace it.

---

## First: where does a document's content actually live?

Here is the surprising part, and it is worth saying before anything else.

The `documents` row does **not** hold the text of the memo.

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

When Mara creates the memo, `snapshot` is `NULL`.

The document is real. It has an id, a title, an owner. It just has no content yet.

The content is a CRDT — a Yjs document — and it does not get written here the way you would write a string to a column. It gets *seeded* the first time someone opens the memo and types (that is M3), or by the PDF import pipeline (step 3).

So the interesting design is not the columns. It is *how the content will be saved* once it exists.

---

## The naive save, and why it loses work

The obvious way to persist an editor: every time the document changes, write the whole thing back.

    Mara types a word
    ↓
    serialize the entire document
    ↓
    UPDATE documents SET snapshot = <whole doc>

This is bad two ways.

It writes the *entire* document on every keystroke. A 40-page memo, rewritten because she fixed a typo. Wasteful, and it gets worse as the doc grows.

So people debounce it: "only save every 2 seconds."

Which trades one problem for a worse one.

Now picture the process dying at second 1.9. The container redeploys, or crashes, or the host reboots.

The last ~2 seconds of everyone's typing — gone. It was only ever in memory, waiting for the debounce timer that never fired.

For a tool whose whole point is collaborative editing, silently dropping the last edit is the cardinal sin.

---

## The fix: write a tiny diff immediately, fold it up later

A CRDT does not force you to choose between "save everything" and "save rarely."

Every change Mara makes produces a small binary **update** — the diff of just that change. Yjs hands it to you. It is bytes, and it is small.

So we keep two tiers.

**Tier one — the append-only log.** The instant the sync server receives an update, it appends that update as a row. Durable *now*, no timer:

```ts
// src/db/schema.ts
export const documentUpdates = pgTable('document_updates', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  update: bytea('update').notNull(),     // one Yjs update — the diff of a single change
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

**Tier two — the snapshot.** A single background worker periodically reads the log, merges every update into one compacted state, writes it to `documents.snapshot`, and trims the rows it folded in.

To **fold** means to take the snapshot plus the little update rows, replay them into one Y.Doc, re-encode that single state, and write it back as the new snapshot. Many small diffs collapse into one compacted blob. Then the rows that went into it are deleted, because the snapshot now stands for them.

The flow, end to end:

    Mara types
    ↓
    Yjs produces a small update (a diff)
    ↓
    APPEND it to document_updates          (tier 1 — durable immediately)
    ↓  ... seconds later, in the worker ...
    read snapshot + every remaining update
    ↓
    merge into one state
    ↓
    write documents.snapshot, delete exactly the rows folded   (tier 2 — compacted)

Loading the memo back is the same idea in reverse:

    snapshot  +  replay every update still in the log  =  current document

The append is what kills the data-loss window. The change is on disk before the editor even repaints. The snapshot is just an optimization on top, so the log never has to be replayed from the beginning of time.

The M1 milestone builds the *tables* for both tiers. The sync server that does the appending is M2. The worker that does the folding is M4. The shape is in place now so neither of those is a schema change later.

---

## Why `seq`, and the housekeeping it enables

One column looks like bookkeeping but does real work: `document_updates.seq`, a `bigserial` — an always-increasing number Postgres assigns on insert. Yjs updates are *commutative* (apply them in any order and you still converge), so `seq` is **not** there to make merging safe. It does two smaller jobs: it gives the log a stable order so a rebuild is deterministic (identical every time), and it lets a fold name exactly which rows it folded.

That fold is **compaction**, and it is the part of this design with real teeth. The obvious way to track "how much has been folded" — a `seq` watermark stored on the row — silently *loses edits* under concurrent writes, and serializing two folds without blocking the writers needs exactly the right Postgres lock. That earns its own milestone (M4) and its own walkthrough:

> **→ See [`04-compaction-and-the-update-log.md`](./04-compaction-and-the-update-log.md)** for what compaction is, the watermark bug, and the fix.

Here it is enough to hold the shape: **append now, fold later; load = snapshot + whatever rows have not been folded yet.**

---

## The REST layer: owner-scoped, and a 404 that means "not yours"

The HTTP routes are deliberately small — list, create, get, delete — and every one is gated by the same session check the auth routes use:

```ts
// src/documents/routes.ts
app.get('/:id', async (req) => {
  const { userId } = await requireSessionUser(req)
  const { id } = parseOrThrow(documentIdParams, req.params)
  const document = await getDocumentForOwner({ documentId: id, ownerId: userId })
  if (document === null) {
    throw notFound('document_not_found', 'Document not found.')
  }
  return { document }
})
```

There are no teams yet — that is step 4. So for now the authorization rule is the simplest possible one: **you can see a document only if you own it.** The owner check lives in the query itself, not in an `if` after the fetch:

```ts
// src/documents/documents.ts — the WHERE is the authorization
.where(and(eq(documents.id, input.documentId), eq(documents.ownerId, input.ownerId)))
```

Notice what happens when Mara's stranger asks for her memo by id. The query matches no row. The function returns `null`. The route answers **404**, not 403.

That is on purpose.

A 403 ("forbidden") would confirm the document exists — Mara's stranger now knows there is a real document at that id, they just can't have it. A 404 says nothing. Yours or imaginary, you get the same answer. The endpoint is not an existence oracle.

The same `getDocumentForOwner` check will gate the WebSocket upgrade in M2, so "can read this over REST" and "can join its live editing room" can never drift apart — there is one rule, asked the same way in both places.

The five questions for this milestone:

    Where does it run?        The server. The CRDT lives in the sync process; Postgres is its disk.
    What shape is the data?   A documents row (metadata) + many small binary updates + one binary snapshot.
    What gets stored?         Every change as an appended update, immediately; a compacted snapshot, eventually.
    What's computed fresh?    On load: snapshot + replay of the remaining updates → the current document.
    What's handed on?         A document id and an owner check that M2's sync layer reuses on ws upgrade.

---

## When this shape is overkill

Two tiers is not free. It is two tables, a background worker, and a compaction step (doc 04), all to persist one document.

If this were a notes app where one person edits one doc and a lost half-second of typing is a shrug — you would not build this. You would `UPDATE` a column on a debounce and move on.

We build it because the doc is *shared and live*. Several people, several server instances, edits that must survive a redeploy mid-sentence. That is the case where "append now, compact later" earns its keep.

The whole thing in three beats:

    The append-only log saves every change the instant it happens.
    The snapshot folds that log into one state so loading stays cheap.
    The owner check is the only door, and a stranger's knock gets a 404, not a hint.
