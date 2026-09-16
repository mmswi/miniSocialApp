# The teammate joins the room — one resolver for REST and realtime

> Increment: step 4 · M5 — websocket join gate.
> Files: `src/sync/ws-routes.ts` (`preValidation`), `src/sync/sync.test.ts`.

Every earlier M5 doc built toward one moment: a person who is *not* the document's owner opening it and editing it live, in the same room as the owner. This doc is that moment. And the change that unlocks it is three lines.

The example, one more time:

    Ana owns "Q3 Launch Plan".
    She shared it into Design (write).
    Ben is in Design.

Ben opens the editor. His browser does two things: it `GET`s `/documents/q3-launch-plan` for the title, and it opens a websocket to `/documents/q3-launch-plan/sync` for the live content. Both have to let Ben through, or he sees nothing.

[Doc 10](./10-effective-access-max-level-in-ts.md) already fixed the `GET`. This doc fixes the socket.

---

## The bug before the fix: the room was owner-only

Here's what the websocket upgrade checked *before* M5:

```ts
// ✗ src/sync/ws-routes.ts (before) — the room gate was owner-only
const document = await getDocumentForOwner({ documentId, ownerId: active.userId })
if (document === null) {
  return reply.code(404).send({ error: 'document_not_found' })
}
```

Trace Ben through it. `getDocumentForOwner` matches a row only when `owner_id` is the caller. Ben isn't the owner — Ana is. So it returns `null`, and Ben's upgrade is refused with a `404`.

The result was a split brain. After [doc 10](./10-effective-access-max-level-in-ts.md), Ben's `GET /documents/:id` **succeeds** (he's a Design member). But his socket **fails**. His editor page would load the title, then sit forever on "Connecting…", because the one thing that carries the actual document content — the ws — slammed the door. Read access over REST, no access over realtime. The two gates disagreed.

## The fix: gate the room with the SAME resolver as the read

```ts
// ✓ src/sync/ws-routes.ts (after) — the room gate is the effective-access resolver
const access = await getDocumentAccessForUser({ documentId, userId: active.userId })
if (access === null) {
  return reply.code(404).send({ error: 'document_not_found' })
}
```

That's it. One function swapped for another. But look at what it buys.

`getDocumentAccessForUser` is the exact function [doc 10](./10-effective-access-max-level-in-ts.md) built and the exact function the REST `GET` calls. So now:

    can GET /documents/:id over REST   ⟺   can open its /sync room
    (both = getDocumentAccessForUser(...) !== null)

They're the same computation, on the same inputs. Not two checks a developer has to remember to keep in step — *one* check, called from two places. Ben passes the resolver (Design → write), so his socket opens. A total stranger (Ana's `strangerCookie` in the tests — no ownership, no shared team) still resolves to `null` and is still refused `404`, with the same [no-oracle](./02-team-authorization-404-not-403.md) silence as REST. Parity by construction.

The proof is a test that is the literal user goal — two different people editing one document live:

```ts
// src/sync/sync.test.ts
const memberCookie = await shareDocumentWithNewMember(documentId, TEAM_ACCESS_LEVELS.write)
const owner  = await connect(documentId, ownerCookie)
const member = await connect(documentId, memberCookie)

owner.type('from the owner')
await waitFor(() => member.text() === 'from the owner')     // owner's edit reaches the teammate

member.type(' and the teammate')
await waitFor(() => owner.text() === 'from the owner and the teammate')  // and back
```

Owner and teammate, one room, edits flowing both ways. That's M5.

---

## What M5 deliberately leaves open (and M6 closes)

Be honest about the seam. The gate you just saw decides **whether you may join**. It does **not** decide **what you may do once in**.

So walk a read-level member through it. Cass is in Legal (read). "Q3 Launch Plan" is shared into Legal. Cass's `GET` says `access: 'read'`. Her socket upgrade? Also allowed — `getDocumentAccessForUser` returns `read`, which is not `null`, so she joins. Good: a reader *should* join, because joining is how she receives the live content to read.

But once her socket is open, the room ([doc-room.ts](./06-inviting-and-accepting.md) territory) relays whatever messages arrive. It doesn't yet look at *her level*. So if Cass's client sends an edit over that socket, the server applies and broadcasts it. **A read-level member can currently write over the websocket.**

This is a real gap, and it's stated plainly here so it isn't forgotten:

    REST PATCH  → Cass (read) is correctly 403'd. Closed.
    WS message  → Cass (read) can still edit. OPEN until M6.

M5 sanctions this — the plan says the backend is "shippable after M6," not after M5. M6 is exactly the fix: the ws connection will carry a `canEditDoc` flag (from `canWriteDocument`, the same predicate [doc 10](./10-effective-access-max-level-in-ts.md) uses for PATCH), and `doc-room.ts` will drop a reader's inbound sync updates per message while still letting SyncStep1 and awareness through (so she keeps *receiving*). That's why the fix here **deliberately did not** stash access on the request — keeping the `preValidation` clean leaves M6 a single obvious seam to add the flag, rather than half a mechanism to untangle.

For a write-level teammate like Ben, none of this matters — he's allowed to write anyway. The live co-edit works today. The gap is only that reads aren't yet read-*only* over the socket.

---

The five questions for this milestone:

**Where does this run?**

The server, in the websocket `preValidation` — before the socket opens, so a refused caller never gets a live connection, only a clean HTTP `404`/`401`.

**What shape is the data?**

In: a document id (URL) + the session cookie. Out: an accepted upgrade, or an HTTP error. No document bytes flow here — those come after, over the open socket.

**What gets stored?**

Nothing. The gate is a pure read of ownership + shares + membership, via the resolver.

**What's computed fresh?**

The join decision, on every upgrade — the same live `getDocumentAccessForUser` call the REST read makes. Access is never cached at the gate.

**What's handed on?**

An open room to everyone who may read the document — owner or shared-team member alike. M6 takes it from here: same room, but now the server enforces per-message what each connection's level allows.

---

The whole idea in three beats:

    The room was owner-only, so a teammate who could READ the doc over REST couldn't JOIN its live room — a split brain.
    Gate the socket with the SAME resolver as the read, and the two can never disagree: join ⟺ read, by construction.
    Joining is settled; per-message write enforcement is not — a reader can still write over the ws until M6 adds canEditDoc.

This closes M5. The document-sharing backbone is complete: a document can be shared into teams, effective access is one resolver, and REST and realtime agree on who gets in. The one honest gap — read-only-over-the-wire — is M6's whole job, and it starts at the clean seam this doc was careful to leave.
