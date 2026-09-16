# One question, one query: what can THIS person do to THIS document?

> Increment: step 4 · M5 — effective-access resolver + document routes.
> Files: `src/documents/access.ts` (`getDocumentAccessForUser`, `canWriteDocument`),
> `src/documents/routes.ts`, `src/teams/authz.ts` (`TEAM_ACCESS_LEVEL_RANK`).

Before M5, a document's access was one fact: `documents.owner_id`. The route asked "are you the owner?" and that was the whole story ([the old `getDocumentForOwner`](./01-the-teams-data-model.md)).

Now there are two ways to reach a document — you own it, or it's [shared into a team you're in](./09-additive-sharing-assign-a-document.md) — and teams carry *levels*. So the question got bigger:

    Given who you are, and every team this document is shared into,
    what is the single most you're allowed to do to it?

This doc is the one function that answers it, and the four routes that now ask.

Our example, grown:

    Ana owns "Q3 Launch Plan".
    It's shared into Design (write) and Legal (read).
    Ben is in Design AND Legal. Cass is in Legal only. Dan is in neither.

What can each of them do?

    Ana  → owner (everything)
    Ben  → write   (max of Design=write and Legal=read)
    Cass → read    (only Legal)
    Dan  → nothing (404 — he can't even tell the doc exists)

That table is the entire job of `getDocumentAccessForUser`.

---

## First, rank the levels — in TypeScript, not SQL

To take the *max* of "write" and "read", the levels need an order. [Doc 02](./02-team-authorization-404-not-403.md) already did this for roles; access levels get the same treatment:

```ts
// src/teams/authz.ts
export const TEAM_ACCESS_LEVEL_RANK: Record<TeamAccessLevel, number> = {
  [TEAM_ACCESS_LEVELS.read]: 1,
  [TEAM_ACCESS_LEVELS.write]: 2,
  [TEAM_ACCESS_LEVELS.delete]: 3,
}
```

You might reach for SQL `MAX()` over the enum instead. Don't. A Postgres enum's sort order is its *declaration order* — reorder the enum in a migration and "which level wins" silently changes underneath you. Rank is a domain rule: read ⊂ write ⊂ delete. It belongs in code where it reads, and where `Record<TeamAccessLevel, number>` makes forgetting to rank a new level a compile error.

## The query: start at the document, fan out, keep every row

The naive approach is three trips: read the doc, read its shares, read your memberships, then combine in code. That's a lot of round trips and a lot of room for the three reads to disagree if something changes between them.

One query does it. Start from the document and `LEFT JOIN` outward:

```ts
// src/documents/access.ts (the query)
.from(documentsTable)
.leftJoin(documentTeamsTable, eq(documentTeamsTable.documentId, documentsTable.id))
.leftJoin(teamMembersTable, and(
  eq(teamMembersTable.teamId, documentTeamsTable.teamId),
  eq(teamMembersTable.userId, input.userId),          // ← only THIS user's memberships
))
.leftJoin(teamsTable, eq(teamsTable.id, documentTeamsTable.teamId))
.where(eq(documentsTable.id, input.documentId))
```

Read it as a fan-out:

    documents ─LEFT─ document_teams ─LEFT─ team_members (team AND this user) ─LEFT─ teams

For Ben asking about "Q3 Launch Plan", the rows come back like this:

    doc            owner  callerRole   teamAccessLevel
    ─────────────  ─────  ──────────   ───────────────
    q3-launch-plan ana    member       write            ← Design (Ben is in it)
    q3-launch-plan ana    member       read             ← Legal  (Ben is in it)

Two shares, two rows. The `teamAccessLevel` is the team's level; `callerRole` is non-null only where Ben is actually a member — which is the join's whole trick. Because `team_members` is joined **on the team AND on Ben's user id**, a share into a team Ben *isn't* in still produces a row (LEFT join), but with `callerRole = null`. That row grants nothing.

Two details that matter:

**Why LEFT, not INNER.** If every join were INNER, a document with *no shares at all* would produce **zero rows** — and then Ana couldn't be recognized as its owner, because there'd be no row carrying `owner_id`. LEFT keeps one all-null-teams row for an unshared doc, so the owner check always has the document to look at.

**Why only this user's memberships in the join.** Putting `teamMembersTable.userId = input.userId` *in the join condition* (not a WHERE) means non-members show up as `callerRole = null` rather than vanishing. We need to see the shares to know they don't grant *this* user anything — and we must never accidentally count a team the user isn't in. (There's a test for exactly this: a doc shared into a `delete`-level team the user isn't in must not bump their access above the `read` team they *are* in.)

## Then fold the rows into one answer, in code

```ts
// src/documents/access.ts (the fold)
if (firstRow.ownerId === input.userId) {
  return { access: DOCUMENT_ACCESS_OWNER, document }       // owner beats every team level
}

let bestLevel: TeamAccessLevel | null = null
for (const row of rows) {
  const level = row.teamAccessLevel
  const isMemberOfShareTeam = row.callerRole !== null
  if (!isMemberOfShareTeam || level === null) continue      // a team you're not in grants nothing
  if (bestLevel === null || TEAM_ACCESS_LEVEL_RANK[level] > TEAM_ACCESS_LEVEL_RANK[bestLevel]) {
    bestLevel = level
  }
}

if (bestLevel === null) return null                          // no owner, no shared team → 404
return { access: bestLevel, document }
```

Owner short-circuits first — Ana is the owner even if she's also in a lowly read team; ownership isn't a team grant, it sits above the chain. Otherwise we walk the rows and keep the highest level from a team the user is genuinely in. Ben's two rows fold to `write`. Cass's single row folds to `read`. Dan has no member row at all, so `bestLevel` stays `null`.

That `null` is the same non-oracle rule from [doc 02](./02-team-authorization-404-not-403.md), now for documents: it becomes a `404`, indistinguishable from a document that doesn't exist. Dan can't tell "Ana's doc exists but I can't see it" from "no such doc." The `404` says nothing.

The returned `access` is a small union — `'owner' | 'read' | 'write' | 'delete'` — named `DocumentAccess`. `'owner'` is a named constant (`DOCUMENT_ACCESS_OWNER`), not a bare string, so no route hard-codes it.

---

## The four routes now ask this one function

Every `/documents/:id` route was owner-only. Now each resolves access first and branches:

```
GET    /documents/:id        → resolve; null → 404; else { document, access }
PATCH  /documents/:id        → resolve; null → 404; !canWriteDocument → 403; else rename
DELETE /documents/:id        → resolve; null → 404; access !== 'owner' → 403; else delete
GET    /documents/:id/teams  → resolve; null → 404; access !== 'owner' → 403; else list shares
```

Three things to notice:

- **GET hands back `access`.** The client learns its own level in the same response as the document — that's what M9's read-only editor will read to show a "View only" chip instead of an editable title.
- **PATCH uses `canWriteDocument`.** That predicate — `owner || level ≥ write` — is the *single* definition of "may write." Ben (write) renames fine; Cass (read) gets `403`, not `404`, because she can see the doc and deserves the honest "you're read-only" answer. And this same predicate is what the ws write-gate will read in [doc 11](./11-rest-ws-parity-the-resolver-gates-the-room.md) — one rule, so REST and realtime can't disagree.
- **DELETE and the share-panel stay owner-only.** Hard delete is Ana's alone — not even a `delete`-level member can destroy the doc (that level only lets them *unshare* it, per [doc 09](./09-additive-sharing-assign-a-document.md)). And only Ana may see the full list of teams her doc reaches.

The old owner-scoped `renameDocumentForOwner` is gone — its WHERE clause *was* the authorization, and authorization now lives in the resolver. In its place, `renameDocument` updates by id, trusting the route to have checked `canWriteDocument` first. The authorization moved up one layer, to the one place both REST and (next) the ws upgrade share.

---

The five questions for this milestone:

**Where does this run?**

The server. One `getDocumentAccessForUser` call per request, in the `/documents` route handlers.

**What shape is the data?**

In: a document id + a user id. Out: `{ access: 'owner' | 'read' | 'write' | 'delete', document }`, or `null`.

**What gets stored?**

Nothing. This is a pure read. The shares it reads were written by [doc 09](./09-additive-sharing-assign-a-document.md); rename/delete write, but the *access decision* stores nothing.

**What's computed fresh?**

The whole answer, every request. Access is never cached — it's derived live from current ownership + current shares + current memberships, so a just-removed membership takes effect on the very next request.

**What's handed on?**

A single, reusable access decision. [Doc 11](./11-rest-ws-parity-the-resolver-gates-the-room.md) hands the ws sync upgrade the *same* function, so "can read this over REST" and "can join its live room" become the same computation — parity by construction, not by two checks kept in sync by hand.

---

The whole idea in three beats:

    Owner beats everything; otherwise your access is the MAX level over the teams that hold both you and the doc.
    One LEFT-JOIN query fans the document out to its shares and your memberships; the fold happens in TS, where the rank rule reads.
    No path to the doc → null → 404, the same no-oracle answer teams give — and the one resolver now feeds every document route, REST and (next) realtime.

Next: [doc 11](./11-rest-ws-parity-the-resolver-gates-the-room.md) points the websocket upgrade at this same resolver, so a teammate can finally join the live editing room — and flags the one thing M5 leaves open for M6.
