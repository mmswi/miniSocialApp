# How concurrent edits actually merge (the CRDT algorithm)

> Companion deep-dive to docs 02–03. This is **Yjs's** algorithm (called YATA, for *Yet Another
> Transformation Approach*), not ours — our
> hand-built layer (doc 02) only *relays* the updates Yjs produces. This doc opens the box: what is
> *inside* those updates, and why applying them in any order lands every screen on the same text.

Doc 02 made one big claim and then walked past it:

> A CRDT is a data structure where concurrent edits merge deterministically. Two people change it independently, you apply both changes in any order, and everyone lands on the *same* final state.

That sentence is doing enormous work, and "merge deterministically" is exactly the part that sounds like magic. This doc is the how.

The vocabulary that usually gets dumped on you:

CRDT.

YATA.

Tombstone.

Client id.

State vector.

By the end each one is a small, concrete thing you can trace with your finger.

Here is the one question underneath all of it:

    Mara and Theo type into the same paragraph at the very same instant.
    No server decides who wins.
    How does every screen still end up showing the exact same text?

I'll follow Mara and Theo through it. To keep ids readable I'll call Mara **client 1** and Theo **client 2** (real client ids are big random numbers; small ones here just so you can read them).

---

## The naive model, and why it cannot merge

Model the document the obvious way: a string, and edits that name a position.

    "insert 'X' at position 5"
    "delete position 3"

Watch it break. The doc is `base` — positions `b=0 a=1 s=2 e=3`. Two concurrent edits, neither has seen the other:

    Mara:  insert 'X' at position 0
    Theo:  delete position 2     (he means 's')

Apply Mara's, then Theo's:

    "base"  --insert 'X' at 0-->  "Xbase"
    "Xbase" --delete position 2-->  "Xbse"   ← deleted 'a', not 's'

Theo meant to delete `s` (index 2 in `base`: `b=0 a=1 s=2 e=3`). But Mara's insert shifted every position right by one, so in `Xbase` index 2 now points at `a`. The delete landed on the wrong character.

The problem is that a position is **not stable**. It means one thing before a concurrent edit and another thing after.

Operational Transformation (OT) patches this by *transforming* each operation against the others — "Theo's position 2 must become 3, because Mara inserted to its left." It works, but every pair of operation types needs its own transform function, and OT is notoriously easy to get subtly wrong.

CRDTs take the other road: build positions that never shift in the first place.

---

## The idea: give every character a permanent name

Stop saying "position 5." Say "the character *between this one and that one*."

If every character has a permanent name, then "between X and Y" means the same thing forever — no matter how much gets inserted around it.

Build that up in three pieces.

**1. Every inserted character is an *item* with a permanent *id*.** The id is a pair `(client, clock)`:

- `client` — a number unique to each editor (each Y.Doc). Mara is 1, Theo is 2.
- `clock` — a counter that ticks up by one for each item that client creates. Mara's first character is `(1,0)`, her next `(1,1)`, and so on. (Yjs actually coalesces a run of adjacent characters into a single item and advances the clock by the item's *length* — so the clock counts characters, not keystrokes. With the one-character-at-a-time examples here, that's simply one per character.)

The id never changes. A character inserted as `(1,0)` is `(1,0)` for the rest of the document's life.

**2. The document is not a string. It is a doubly-linked list of items.** To get the text, you *walk* the list left to right and concatenate the content. Positions are emergent, not stored.

    (start) ⇄ [ H (1,0) ] ⇄ [ i (1,1) ] ⇄ (end)
              each item = { id, origin, content, deleted }

**3. Each item remembers its *origin*: the id of the item that was on its left at the moment it was inserted.** That is its anchor. "I was inserted right after `(1,0)`." Because ids never change, that anchor is permanent — even if ten other characters later land nearby.

Inserting is now just: make an item, set its origin to its left neighbor's id, and splice it into the list. No offsets exist anywhere, so there is nothing to shift.

---

## The hard case: two inserts at the same spot

Here is where determinism is actually won or lost.

Empty document. Mara and Theo both type at the very start, the same instant, neither has seen the other:

    Mara inserts 'A'  →  item (1,0), origin = (start)
    Theo inserts 'B'  →  item (2,0), origin = (start)

Both items have the **same origin** — the start of the document. Both want to be the first character. When the two updates meet, every replica must put them in *some* order. And it has to be the **same** order on every machine, or Mara's screen shows `AB`, Theo's shows `BA`, and they have diverged forever.

YATA's rule: when two items share an origin (a concurrent insert at the same place), order them by **client id** — the same comparison on every machine. The lower client id sits to the left.

    same origin → compare client ids → lower client id goes left

So `(1,0) 'A'` lands to the left of `(2,0) 'B'`. Every replica computes the identical thing, because the client ids are baked into the items and travel inside the update. The result, everywhere:

    "AB"

I ran exactly this through Yjs to be sure:

    apply Mara's update then Theo's  →  "AB"
    apply Theo's update then Mara's  →  "AB"     (same answer, either order)

Look at what happened. The two edits did **not** fight. Both survived. The tiebreak only decided their *order*, and it decided it identically for everyone. That is the whole CRDT trick: a conflict becomes a deterministic *ordering*, never a winner and a loser.

(The full YATA rule has a couple more cases — when two items' origins differ but their ranges interleave — but they all resolve the same way: a fixed comparison on immutable ids, so every replica agrees.)

---

## Different spots: nothing to resolve

If two concurrent inserts have *different* origins, there is no conflict at all — they anchor in different places.

Document is `base`. Concurrently:

    Mara inserts 'X' before 'b'   →  origin = (start)
    Theo inserts 'Y' after 'e'    →  origin = id of 'e'

Different anchors, different places, so the merge just keeps both:

    "XbaseY"      (verified through Yjs)

Both edits survive untouched. This is doc 02's "Mara fixes the heading while Theo rewrites a sentence" — now you can see *why* nothing clobbers: they were never competing for the same anchor.

---

## Deleting does not remove — it tombstones

One subtlety makes deletes safe. If you truly spliced a deleted item out of the list, any other item whose origin pointed at it would lose its anchor. So you never remove an item. You mark it **deleted** — a **tombstone** — and skip it when walking the list to render.

Document is `XY`. Concurrently:

    Mara deletes 'X'                      →  X becomes a tombstone
    Theo inserts 'Z' right after 'X'      →  Z's origin = id of 'X'

Now merge and walk the list:

    [ X (deleted) ] ⇄ [ Z ] ⇄ [ Y ]
       skip            keep    keep
    render → "ZY"     (verified through Yjs)

`X` is invisible, but it is still *there* as an anchor, so `Z` (whose origin is `X`) sits exactly where `X` was — before `Y`. If `X` had been truly removed, `Z`'s anchor would be gone and `Z` would have nowhere to attach.

The tombstone keeps the map intact. (Yjs later garbage-collects tombstones it can prove are safe to compress, but the anchor point conceptually persists.)

---

## Why it always converges

Three facts, taken together, are the whole guarantee:

- ids are **immutable** — an item's name never changes.
- origins are **stable** — they point at ids, which never change.
- the tiebreak is a **deterministic function of immutable data** (client ids) — every replica computes the same order from data it already holds.

So applying the same set of updates in *any* order builds the same linked list, which renders the same text. That is the "Yjs updates are commutative" line that docs 01 and 02 lean on — now cashed out. It is not magic. It is: *every decision is a fixed function of data every replica already has.*

    same updates, any application order  →  same list  →  same text

---

## How this rides our wire (tying it to the code)

We did not write YATA — Yjs did. Our hand-built layer (doc 02) is the postal service; this algorithm is what is written on the letters.

A Yjs **update** — the binary blob doc 02 ships over the socket — is exactly a serialized batch of these items: their ids, their origins, their content, and any new tombstones. Applying an update means running the splice-by-origin integration above. That is why the relay can be dumb: it never interprets an update, it just delivers it, and Yjs's integration does the converging on each end.

    src/sync/doc-room.ts — the room broadcasts the update bytes; it never looks inside them.
    Yjs, on each client, is what reads the items and splices them in.

And the **state vector** from doc 02's handshake is now concrete. It is a map:

    client → the highest clock I have seen from that client

"What am I missing?" is then just: any item whose `(client, clock)` is past your vector. That is how a reconnecting client asks for *exactly* the items it lacks — the ids themselves are the bookmarks.

The five questions for the merge:

    Where does it run?      On every replica — each browser's Yjs runs the same integration. No server referee.
    What shape is the data? A linked list of items {id, origin, content, deleted}; an id is (client, clock).
    What gets stored?       The items, tombstones included (they are the anchors), serialized into the updates we persist.
    What's computed fresh?  The merge — splicing each arriving item by its origin, ordering any ties by client id.
    What's handed on?       A converged list, identical on every replica, that renders to identical text.

---

## The cost, and when not to reach for it

A CRDT is not free. Every character carries an id and an origin, and deletes leave tombstones, so the in-memory structure is bigger than the visible text — sometimes much bigger for a heavily revised document. Yjs fights this hard (it runs adjacent items together into ranges, encodes ids compactly, and garbage-collects safe tombstones), but the overhead is real.

If there are no concurrent editors — a single writer, or a server that can be the one source of truth — you do not need any of this. A plain "last write wins" column, or server-side OT, is lighter. A CRDT earns its overhead precisely when there is **no referee** and edits must merge on their own.

Which is exactly our case: several people, several server instances, edits in flight at the same moment.

The whole thing in three beats:

    Every character gets a permanent name, so "between X and Y" never shifts.
    Concurrent inserts at one spot are ordered by client id — the same decision on every machine.
    Deletes tombstone instead of removing, so every anchor survives — and the list converges, in any order.
