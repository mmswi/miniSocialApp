# Sharing a document with a team — why it's a whole separate table

> Increment: step 4 · M5 — document ↔ team sharing (the join table).
> Files: `src/db/schema.ts` (`documentTeamsTable`), `drizzle/0006_document_teams.sql`.

Up to now a document has had exactly one relationship to a person: `documents.owner_id`. One document, one owner. That's the whole access story — [doc 01](./01-the-teams-data-model.md) built teams as groups of people, but nothing yet connects a document *to* a team.

This milestone (M5) connects them. And the first question is where the connection lives.

Here's the example we'll carry the whole way through:

    Ana owns a document, "Q3 Launch Plan".
    She wants the Design team to edit it.
    She also wants the Legal team to read it.

One document. Two teams. Different access in each.

---

## The tempting wrong answer: a `team_id` column on documents

The obvious move is to put the team right on the document:

```ts
// ✗ documents gains a team_id column
export const documentsTable = pgTable('documents', {
  // ...
  teamId: uuid('team_id').references(() => teamsTable.id),
})
```

Now trace Ana's case through it.

"Q3 Launch Plan" goes to the Design team — set `team_id` to Design. Fine.

Then she shares it with Legal too. There's one column. It already holds Design. There is nowhere to put Legal.

A single column can point at one team. Ana needs it to point at two — and later maybe five. The shape is wrong before we've written a query. One document reaching many teams is a **many-to-many** relationship, and a column on one side can only ever model many-to-*one*.

## The right answer: a table whose rows ARE the shares

So the connection doesn't live on the document, and it doesn't live on the team. It lives in its own table, where **each row is one share**.

```ts
// src/db/schema.ts
export const documentTeamsTable = pgTable('document_teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documentsTable.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').notNull().references(() => teamsTable.id, { onDelete: 'cascade' }),
  addedById: uuid('added_by_id').references(() => usersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Ana's case is now two rows:

    document_id            team_id           added_by_id
    ─────────────────────  ────────────────  ───────────
    q3-launch-plan         design-team       ana
    q3-launch-plan         legal-team        ana

Want to add a third team? Insert a third row. Want to unshare from Legal? Delete that one row — Design is untouched. The document itself never changed; only the set of rows pointing at it did.

Notice what the row does **not** carry: an access level. There's no `read`/`write` here. The level lives on the *team* (`teams.access_level`, from [doc 01](./01-the-teams-data-model.md)) — Design is a write team, Legal is a read team. A share just says "this doc is now visible to this team"; the team decides what its members can *do*. That split is the whole reason [doc 10](./10-effective-access-max-level-in-ts.md) can compute one person's effective access by joining these rows to the teams they're in.

This is **additive** sharing. A row here *grants* the team's members access on top of whatever they already had; it never touches Ana's own access. She owns the doc — deleting every share row still leaves her the owner. Sharing adds; unsharing subtracts exactly what it added.

---

## The three FK rules, and why each one is what it is

Every column that points at another table has to answer: what happens when the thing it points at is deleted? Three foreign keys, three deliberate answers.

**`document_id` → cascade.** Delete "Q3 Launch Plan" and its share rows delete with it. A share to a document that no longer exists is garbage — there's nothing to share.

**`team_id` → cascade.** Delete the Legal team and the "shared with Legal" row goes too. Same reason: a share into a team that's gone means nothing.

**`added_by_id` → set null.** This one is different, and it's the same choice `teams.created_by_id` made in [doc 01](./01-the-teams-data-model.md). `added_by_id` records *who shared it* — a footnote, not a permission. If Ana's account is later deleted, the document should stay shared with Design and Legal; those teams still need it. So the row survives with `added_by_id` set to null.

The tell: cascade is for "this row is meaningless without that thing." Set-null is for "this row outlives that thing." The document and the team are *what the share is*. The sharer is just *who did it once*.

And critically — `added_by_id` is **not** the authority to unshare. You might assume whoever shared a doc is who can unshare it. Not here. [Doc 09](./09-additive-sharing-assign-a-document.md) computes that from the doc's owner and the caller's team role, never from this column. `added_by_id` is for showing "shared by Ana" in a UI, nothing more.

## One share per pair — the unique index

```ts
uniqueIndex('document_teams_document_team_unique').on(t.documentId, t.teamId)
```

Ana shares "Q3 Launch Plan" with Design. Then she clicks share-with-Design again (double-click, two tabs, a retry). Without a rule, that's a second identical row — the doc is now "shared with Design" twice, and unsharing once leaves the other behind.

The unique index makes (document, team) appear **at most once**. The second insert fails at the database with a `23505` (unique violation), which [doc 09](./09-additive-sharing-assign-a-document.md) catches and turns into a `409 Conflict` — "already shared." The database is the arbiter, so two requests racing at the same instant can't both win: one inserts, the other gets the `23505`. No check-then-insert gap to lose the race in.

The `document_teams_team_idx` index on `team_id` answers the other direction of the question — "which documents does this team hold?" — which is exactly the team page's document list. Postgres scans by team instead of reading every share row.

---

The five questions for this milestone:

**Where does this run?**

The database. This slice is pure schema — one `CREATE TABLE` in `drizzle/0006_document_teams.sql`. No application code reads or writes it yet; that's [doc 09](./09-additive-sharing-assign-a-document.md).

**What shape is the data?**

One row per share: `(document_id, team_id, added_by_id, created_at)`. No access level — that stays on the team.

**What gets stored?**

The set of shares. Ana sharing one doc with two teams is two rows. The rows are the single source of truth for "who a document is shared with."

**What's computed fresh?**

Nothing yet. The join table just *holds* the shares. Turning them into "what can this specific person do to this specific document" is computed per request in [doc 10](./10-effective-access-max-level-in-ts.md).

**What's handed on?**

A place to record shares, with the delete-behavior and uniqueness rules baked into the schema so the routes on top of it ([doc 09](./09-additive-sharing-assign-a-document.md)) don't have to re-police them.

---

The whole idea in three beats:

    One document reaching many teams is many-to-many, so the link is its own table — one row per share.
    The row carries who and where, never the access level (that lives on the team) and never the right to unshare.
    Cascade deletes a share when its doc or team dies; set-null lets it outlive the person who made it.

Next: [doc 09](./09-additive-sharing-assign-a-document.md) puts routes on top of this table — how Ana actually shares her own document, and who is allowed to unshare it.
