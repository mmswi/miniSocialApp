# How the update log stays small (compaction)

> Increment: step 2 · M4 — the compaction worker.
> Files: `src/sync/compaction.ts`, `src/sync/doc-store.ts` (load), `src/queue/compaction-queue.ts`,
> `src/queue/compaction-worker.ts`.

Doc 01 left a thread hanging.

Every keystroke appends one tiny row to `document_updates`. Durable the instant it lands — that is the whole point of the append log. But a log that only ever grows has a second problem, and doc 01 pushed it here.

This doc is that thread: what **compaction** is, why the obvious version of it silently loses edits, and the one Postgres lock that makes it safe without slowing anyone down.

---

## The problem: the log only grows

Recall the shape from doc 01. A document's content is not a column. It is rebuilt from two parts:

    snapshot  +  replay every update row still in the log  =  the document

Mara opens the *Q3 strategy memo* and types. Each change is one small Yjs update — a few bytes — appended as a row:

    document_updates
    ┌──────┬─────────────┬───────────────┐
    │ seq  │ document_id │ update        │
    ├──────┼─────────────┼───────────────┤
    │  1   │ memo        │ «insert 'Q'»  │
    │  2   │ memo        │ «insert '3'»  │
    │ ...  │ ...         │ ...           │
    └──────┴─────────────┴───────────────┘

On day one, loading the memo replays 200 rows. Fast.

After a week of editing, it is 50,000 rows. Every load replays all of them.

    day 1:   snapshot = ∅   +   replay 200 rows      → fast
    day 7:   snapshot = ∅   +   replay 50,000 rows   → slow, and getting slower

The append log bought durability. It charges for it in load time. Nothing trims the log, so the bill grows forever.

---

## What compaction is

Compaction is the housekeeping that pays that bill.

Every so often, a background worker takes the pile of little updates, merges them into one compacted blob, saves that blob as the snapshot, and deletes the rows it just merged.

That merge has a name: **folding**.

    50,000 little update rows
    ↓  replay them into one Y.Doc, then re-encode it
    1 snapshot blob
    ↓  delete the rows that went into it
    0 update rows left

After a fold, loading the memo reads one blob and replays nothing:

    snapshot = <the whole memo>   +   replay 0 rows   → fast again

That is the entire idea. Compaction is not a new data structure, and it is not a clever merge. It is *replay-then-re-save*, run in the background, so the log never grows without bound.

It helps to say what compaction is **not**:

It is not required for correctness. The append already made every edit durable. If the worker never ran, nothing would be lost — loads would just keep getting slower.

It is not on the editing path. Mara never waits for it. It runs in a separate worker process.

It is not a debounce. We are not delaying the durable write — doc 01 showed why that loses data. The write already happened. Compaction only *consolidates* what is already on disk.

---

## Folding one document, in code

Here is the fold, start to finish. Watch where each step runs.

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

    server (a background worker)
    ↓  read the old snapshot + the loose update rows
    rebuild the document in memory (a Y.Doc)
    ↓  Y.encodeStateAsUpdate → one blob
    write documents.snapshot
    ↓
    delete the folded rows
    ↓
    this document's log is empty again

The five questions, answered:

    Where does it run?      A background worker process — never the request path, never the browser.
    What shape is the data? Binary Yjs updates (rows) in; one binary snapshot blob out.
    What gets stored?       The snapshot replaces the rows; the folded rows are deleted.
    What's computed fresh?  The merged snapshot, each time a document is folded.
    What's handed on?       A short log + a current snapshot, so the next load stays cheap.

---

## When does it run? The sweep

Folding on every keystroke would be absurd — re-encoding a 40-page memo because Mara typed one letter. Never folding makes loads crawl. So we fold on a schedule, and only the documents that need it.

A repeatable job fires every 60 seconds. Each tick is one **sweep**: find the documents whose un-folded log has grown past a threshold, and fold each.

```ts
// src/sync/compaction.ts
export const COMPACTION_THRESHOLD = 200   // fold a document once it has ≥ 200 loose updates

// the work list: COUNT the loose rows per document, keep the ones over the line
.groupBy(documentUpdatesTable.documentId)
.having(gte(count(), threshold))
```

Because folded rows are deleted, the rows left in `document_updates` *are* the un-folded tail — so a plain `COUNT` per document is exactly "how far behind is this one." Over 200, fold it; under, leave it.

The threshold is a **tuning knob, not a correctness one**. Fold more often → a smaller tail and cheaper loads, but more background work. Fold less often → the reverse. Durability does not depend on it at all; only load speed does.

The schedule itself is a BullMQ repeatable job — the same queue machinery the email worker uses:

```ts
// src/queue/compaction-queue.ts — idempotent: re-running on boot keeps ONE schedule, not one per restart
await compactionQueue().upsertJobScheduler(
  COMPACTION_SWEEP_JOB_NAME,
  { every: COMPACTION_SWEEP_EVERY_MS },   // 60s
  ...
)
```

---

## The bug in the obvious version (a watermark loses edits)

Now the part with teeth. How does a fold know *which* rows it folded, so it deletes those and not others?

The tempting answer is a high-water mark. Store a number on the document — call it `snapshotThrough = N` — meaning "the snapshot already folds in every update through seq N." Then:

    load     =  snapshot + replay rows where seq > N
    compact  =  fold rows seq > N, set snapshotThrough = M, delete rows seq <= M

One number. Clean. It even *looks* race-proof: a new append during a fold gets a seq above M, so the delete skips it.

It loses edits. Here is the trace.

`seq` is a `bigserial` — Postgres hands out the number at the moment of **insert**. But a row stays invisible to everyone else until its transaction **commits**, and commits do not finish in the order the numbers were handed out. Our appends are fire-and-forget (`void appendUpdate(...)` in the sync room), so several are genuinely in flight at once.

Watch two appends land while a fold runs:

    1. Append X grabs seq = 11 — has NOT committed yet
    2. Append Y grabs seq = 12 — commits fast
    3. Fold reads "rows where seq > snapshotThrough" → sees 12, NOT 11 (uncommitted = invisible). Folds it, sets snapshotThrough = 12
    4. Fold deletes seq <= 12. Row 11 is still invisible, so it survives the delete
    5. X finally commits seq = 11
    6. Next load replays seq > 12 → row 11 is never replayed

Row 11 is gone. Mara's edit, dropped silently — by the exact layer whose whole job is to never drop one.

The bug hides inside the word *watermark*. `seq <= N` does **not** mean "I have seen everything up to N." A counter that hands out numbers before transactions commit cannot promise that.

---

## The fix: delete what you fold, replay what remains

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

**Load replays every remaining row.** No `seq > N` filter. Folded rows are gone, so whatever is still in `document_updates` *is* the un-folded tail — a late-committing row 11 included:

```ts
// src/sync/doc-store.ts — loadDoc
const pendingUpdates = await db
  .select({ update: documentUpdatesTable.update })
  .from(documentUpdatesTable)
  .where(eq(documentUpdatesTable.documentId, documentId))   // ALL remaining rows, no watermark
  .orderBy(asc(documentUpdatesTable.seq))
```

    fold:  read the loose rows → snapshot them → delete exactly those seqs
    load:  snapshot + replay whatever rows are left

Now run the same race again. Row 11 commits late. The fold never deleted it (it was not in the list). The next load replays every remaining row — row 11 among them — and Yjs's commutativity lands it correctly on top of the snapshot. Nothing lost.

"Which rows did I fold?" is answered by holding the actual list for one transaction, not by trusting a single stored number. (This is why the database still has a `snapshot_through` column from an earlier migration, but the code no longer reads it — the load path replays the full tail instead.)

---

## The second subtlety: one fold at a time, without blocking writers

One race is left. Two sweeps fold the *same* document at the same moment.

    Sweep A reads the loose rows {1, 2, 3}
    Sweep B reads the loose rows {1, 2, 3, 4}
    B finishes first: writes its snapshot (covers 1–4), deletes rows 1–4
    A finishes second: writes ITS snapshot (covers only 1–3)   ← clobbers B's, and row 4 is already gone

Row 4 is lost. So two folds of one document must never run at once. They have to take turns.

The tool for "take turns" is a **lock**: a way for one operation to say "I'm using this — wait for me," so a second one pauses until the first is done. Think of it as the key to a room. The hard part is not that we need a lock. It is that the *obvious* lock breaks the thing we care about most — and seeing why is the whole lesson here, no SQL required.

### Picture the document row as a house

The row in the `documents` table is like a house. It has two very different parts:

- an **address** — its id, the permanent identity that other things point at.
- **contents** — the snapshot, the stuff inside that changes.

Two operations touch this house, and they care about completely different parts of it.

A **fold** rewrites the *contents*. It swaps in a fresh snapshot. It never changes the address.

An **append** — one keystroke being saved — barely touches the house at all. It drops a new row in the log, and that row points back at the house by its address: *"this update belongs to that document."* (The database calls that link a **foreign key** — a row that points at another row's identity.) Before the append is allowed to attach, the database places a light hold on the house meaning: *don't demolish this or change its address while I'm linking to it.* Many appends can hold that at once; they never get in each other's way.

### The obvious lock says too much

The reflex way to make folds take turns: have each fold grab the house *exclusively*. A sign on the door —

> **"Renovation in progress. Keep out. The address itself might change."**

That makes folds take turns, yes. But now no append can attach, because every append needs the address to stay put, and this sign says it might not. So every keystroke-save for that document stalls behind the running fold.

The one path that must never wait — saving people's edits — waits. On a *background cleanup job*. Exactly backwards.

### The honest lock says just enough

But a fold never actually changes the address. Only the contents. So it can hang a more honest sign —

> **"Rearranging the contents. The address stays exactly the same."**

Now both things we need are true at once:

- a **second fold** still can't start — two renovators rewriting the same contents would collide, so folds still take turns, and the race stays closed.
- **appends keep flowing** — they only ever needed the address to stay put, and this sign promises exactly that.

### The same idea, in SQL

Those three signs are real SQL. Postgres calls them **row-level locks**, and you ask for one by adding a `FOR …` clause to an ordinary read. Here is the fold's locking read as raw SQL:

```sql
SELECT snapshot FROM documents WHERE id = $1
FOR NO KEY UPDATE;
```

Read it top to bottom. `SELECT snapshot FROM documents WHERE id = $1` is a plain "give me this one row" query — `SELECT` the columns you want, `FROM` the table, `WHERE` narrows to the row whose `id` matches. (`$1` is a **placeholder**: the document id is not pasted into the query text but sent to the database *alongside* it and slotted in for `$1` at run time. That separation is what stops a malicious value — say `' OR '1'='1` — from being read as SQL instead of data, the bug called SQL injection. Drizzle writes the placeholder for you; you just hand it `documentId`.) On its own that just *reads*.

The last line is the twist. `FOR NO KEY UPDATE` is the lock clause: it tells Postgres *"and lock the row you just handed me — in this mode — until my transaction ends."* So `SELECT … FOR <mode>` reads **and** holds the row, where a bare `SELECT` only reads. The three modes are the three signs from the analogy:

    FOR KEY SHARE       "don't change this row's identity"       ← the append's automatic hold
    FOR NO KEY UPDATE   "I'll change its contents, not its id"   ← the fold
    FOR UPDATE          "I might change anything about it"       ← the greedy one we avoid

We never hand-write that SQL — Drizzle generates it. The method `.for('no key update')` is literally "append `FOR NO KEY UPDATE` to this SELECT." Line for line:

```ts
// src/sync/compaction.ts        the SQL each line becomes:
const [meta] = await tx
  .select({ snapshot: documentsTable.snapshot })   //  SELECT snapshot
  .from(documentsTable)                             //  FROM documents
  .where(eq(documentsTable.id, documentId))         //  WHERE id = $1
  .for('no key update')                             //  FOR NO KEY UPDATE
```

The append's `FOR KEY SHARE` you never write at all — Postgres adds it for you, because of the **foreign key**. Back in the schema, the log's `document_id` column is declared to *reference* a real document:

```ts
// src/db/schema.ts                                   the SQL it generates:
documentId: uuid('document_id').notNull()
  .references(() => documentsTable.id, { onDelete: 'cascade' })
//  →  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE
```

`REFERENCES documents(id)` *is* the foreign key — a rule that every `document_id` in the log must point at a row that actually exists in `documents`. To keep that rule true while a new log row is being inserted, Postgres automatically grabs a `FOR KEY SHARE` lock on the referenced document: "hold this row's identity still until I've finished linking to it." That is the append's hold, taken on your behalf.

One last bit of syntax ties it together: a **transaction**. A lock lasts "until the transaction ends," and a transaction is a `BEGIN … COMMIT` block — a group of statements that all take effect together, or not at all. `db.transaction(async (tx) => { … })` is Drizzle's `BEGIN`/`COMMIT` wrapper; everything that uses `tx` runs inside it. So the fold's `FOR NO KEY UPDATE` lock is held from the locking `SELECT` right up to the final `COMMIT` — exactly the window in which a second fold must wait its turn.

And the two cases that matter fall straight out of which modes clash:

    fold  vs  fold     (NO KEY UPDATE  ✗  NO KEY UPDATE)   → they clash   → folds take turns     ✓ what we want
    fold  vs  append   (NO KEY UPDATE  ✓  KEY SHARE)        → no clash     → they run together    ✓ what we need

The whole point in one line: **the only thing a fold ever waits on — or makes anything wait on — is another fold.**

---

## When you would not bother

Compaction is pure optimization, so the honest question is when to skip it.

If a document barely changes — a handful of edits, ever — its log never grows, and the sweep finds nothing to do. The threshold means most documents are never folded, and that is fine.

If you were building a single-player, rarely-edited app, you could drop compaction entirely and just replay the log on every load. It would never be wrong, only eventually slow.

We build it because these documents are *shared, live, and long-lived* — a contract reviewed by a team over weeks, thousands of edits deep. That is the case where an unbounded log actually hurts, and where folding it down earns its keep.

The whole thing in three beats:

    The append log saves every keystroke immediately — that is durability.
    Compaction folds that log into one snapshot — that is keeping load cheap.
    Delete only what you fold, replay whatever is left — that is never losing an edit to the housekeeping.
