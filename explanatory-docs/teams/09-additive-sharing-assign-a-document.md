# Sharing a document, and who's allowed to un-share it

> Increment: step 4 · M5 — document ↔ team sharing (assignment routes).
> Files: `src/teams/assignments.ts`, `src/teams/routes.ts`
> (`POST`/`GET`/`DELETE /teams/:teamId/documents`).

[Doc 08](./08-the-document-teams-join-table.md) built the table where a share is one row. This doc puts three routes on top of it — share, list, un-share — and the interesting part is not the SQL. It's the permission question, and it's asymmetric: **who may share** is a simple rule, and **who may un-share** is three rules in a trenchcoat.

Same example as before:

    Ana owns "Q3 Launch Plan".
    Ana is a member of the Design team.
    She wants to share her doc into Design.

---

## Sharing: you may share a document you OWN, into a team you're IN

Two gates, both required. Trace Ana's request `POST /teams/design/documents { documentId: "q3-launch-plan" }`:

```ts
// src/teams/routes.ts (the POST handler, trimmed)
await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.member })   // gate 1: are you in this team?
const document = await getDocumentForOwner({ documentId, ownerId: userId }) // gate 2: do you own this doc?
if (document === null) {
  throw notFound('document_not_found', 'Document not found.')
}
```

Gate 1 is [doc 02](./02-team-authorization-404-not-403.md)'s `requireTeamRole` at its lowest bar — `member`. Ana is in Design, so she clears it. A stranger to the team gets `404` here, and that 404 is deliberate: it happens *before* gate 2, so a non-member can never even probe whether some document id exists. They can't tell your team apart from one that isn't there.

Gate 2 is the ownership check. `getDocumentForOwner` returns the doc only if `owner_id` is the caller — otherwise `null`, which becomes a `404`. So Ana can only share *her own* documents. If she names a doc she doesn't own — or a random id — she gets the same `404`. Not a `403`. A `403` would confirm "that document exists, you just can't share it," which is an existence oracle for other people's documents. The `404` says nothing.

Why owner-only sharing? Because sharing is [additive](./08-the-document-teams-join-table.md) — it *grants* access to a whole team. Letting a mere viewer of a doc re-share it would let access leak sideways, team to team, with no owner ever consenting. The owner is the one person entitled to widen who can reach their document.

## Sharing twice: the database says 409, not a check

Ana double-clicks. Two identical `POST`s race. What stops "Q3 Launch Plan" being shared into Design twice?

Not an `if`. The naive version reads first:

```ts
// ✗ Check-then-insert — two concurrent requests both read "not shared", both insert
const existing = await findShare(documentId, teamId)
if (existing) throw conflict(...)
await insertShare(...)   // both requests reach here
```

Between the read and the insert, the other request slips in. Both see "not shared." Both insert. Two rows.

Instead, the data layer just inserts and lets the `unique(document_id, team_id)` index from [doc 08](./08-the-document-teams-join-table.md) be the judge:

```ts
// src/teams/assignments.ts
try {
  await db.insert(documentTeamsTable).values({ documentId, teamId, addedById })
  return DOCUMENT_ASSIGN_RESULTS.created
} catch (error: unknown) {
  if (isUniqueViolation(error)) {          // Postgres 23505
    return DOCUMENT_ASSIGN_RESULTS.alreadyShared
  }
  throw error
}
```

The first insert wins. The second hits the unique index and Postgres raises a `23505`, which `isUniqueViolation` recognizes and we turn into `alreadyShared` → the route answers `409`. There's no window to race through, because the atomic thing *is* the insert. This is the same move [team invites](./06-inviting-and-accepting.md) and account-linking already use.

Notice the return type isn't a boolean or a thrown error — it's a named tag, `DOCUMENT_ASSIGN_RESULTS.created` / `.alreadyShared`. The route reads the tag to choose `201` vs `409`. The data layer reports *what happened*; the route decides *what status that is*.

---

## Un-sharing: three independent doors, then a check

Now Ana — or someone else — wants to remove the share. Who's allowed?

The rule from the plan: **the document's owner, OR a team admin+, OR a plain member when the team's level is `delete`.** Three separate ways in. Any one is enough.

```ts
// src/teams/routes.ts (the DELETE handler, trimmed)
const membership = await getTeamForMember({ teamId, userId })       // role + team access level, or null
const ownsDocument = (await getDocumentForOwner({ documentId, ownerId: userId })) !== null

if (membership === null && !ownsDocument) {
  throw notFound('team_not_found', 'Team not found.')               // neither owner nor member → no oracle
}

const isTeamAdminPlus = membership !== null && TEAM_ROLE_RANK[membership.role] >= TEAM_ROLE_RANK[TEAM_ROLES.admin]
const isDeleteLevelMember = membership !== null && membership.accessLevel === TEAM_ACCESS_LEVELS.delete
const mayUnassign = ownsDocument || isTeamAdminPlus || isDeleteLevelMember
if (!mayUnassign) {
  throw forbidden('insufficient_team_role', 'You do not have permission to do that.')  // in the team, under the bar
}
```

Read `mayUnassign` out loud and it *is* the rule: owns the document, **or** is an admin+, **or** is a delete-level member. Each condition got a name so the `||` reads like the sentence from the plan instead of a puzzle.

Walk the three doors:

- **The owner** (Ana) can always un-share her own doc — even if she later left the team. It's her document; she controls where it reaches. This is why the owner check runs even for a non-member.
- **An admin+** can un-share any doc in a team they administer, including docs they don't own. Managing what the team holds is an admin job.
- **A plain member** can un-share only when the team's access level is `delete`. That's what the `delete` level *means* here (from [doc 01](./01-the-teams-data-model.md)): a team whose members are trusted to remove shares. A `read` or `write` member cannot.

And the two failure codes are the same non-oracle split as everywhere else in [doc 02](./02-team-authorization-404-not-403.md):

    neither the owner nor a member  → 404  (you can't see this team or this share at all)
    a member, but under the bar     → 403  (you're in the team; you just can't do this)

One last check, *after* authorization passes: does the share even exist?

```ts
const removed = await unassignDocumentFromTeam({ documentId, teamId })
if (!removed) {
  throw notFound('document_share_not_found', 'That document is not shared with this team.')
}
```

`unassignDocumentFromTeam` deletes the row and reports whether one was actually there. If the pair was never shared, nothing is deleted and the caller gets a `404`. And note what un-share deletes: the `document_teams` **row**, never the document. Ana's "Q3 Launch Plan" still exists, still hers — it's just no longer reachable through Design. Additive sharing, subtracted.

---

The five questions for this milestone:

**Where does this run?**

The server, in `src/teams/routes.ts` handlers calling `src/teams/assignments.ts`. All three routes sit behind the plugin's auth hook from [doc 07](./07-a-public-route-in-a-private-plugin.md), so every caller is already logged in.

**What shape is the data?**

In: a team id (URL) and a document id (body or URL). Out: for the list, documents with their owner's name; for share/un-share, a status code (`201`/`409`/`204`/`404`/`403`).

**What gets stored?**

One `document_teams` row per share — inserted on `POST`, deleted on `DELETE`. The document and the team themselves are never written here.

**What's computed fresh?**

The permission decision, per request: membership + ownership resolved live, combined into `mayUnassign`. Nothing about "who can touch this share" is precomputed — it's derived each time from current team roles and doc ownership.

**What's handed on?**

A populated `document_teams` table. That's exactly the input [doc 10](./10-effective-access-max-level-in-ts.md) reads to answer the real question: given these shares, what can one specific person actually do to one specific document?

---

The whole idea in three beats:

    You may share a doc you OWN into a team you're IN — one simple rule, guarded owner-only so access can't leak sideways.
    You may un-share three ways — you own it, you're an admin+, or you're a delete-level member — any one door is enough.
    The unique index makes "already shared" a 409 with no race, and un-share removes the share, never the document.

Next: [doc 10](./10-effective-access-max-level-in-ts.md) turns these share rows into an answer — one query that computes a person's effective access to a document, owner or team member, and rewires the document routes onto it.
