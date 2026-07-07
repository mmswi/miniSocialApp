# How SQL works

SQL looks like a wall of shouting keywords.

    SELECT ... FROM ... WHERE ... JOIN ... ON ... GROUP BY ... FOREIGN KEY ... CASCADE

The usual tutorial hands you that wall and starts defining the bricks. Which is not an explanation. It's a glossary.

So let me give you the one idea the whole thing rests on, and then everything above turns into plain sentences.

Here it is:

    A database is a pile of grids.
    SQL is how you talk to the grids.

That's it. That is the whole mental model. A grid is a table — rows and columns, like a spreadsheet with rules. SQL is the language for making grids, putting rows in them, asking questions about them, and connecting one grid to another.

Every keyword below is just a word in that conversation.

I'll use one running example the whole way: a small app with **users**, **teams**, and the memberships that connect them. Three people — Mara, Sam, Theo. One team — *Design crew*. Watch them move through every idea.

---

## A table is a grid

Picture the `users` table as a literal grid.

    id       | email             | name  | email_verified
    ---------+-------------------+-------+---------------
    u_mara   | mara@example.com  | Mara  | true
    u_sam    | sam@example.com   | Sam   | false
    u_theo   | theo@example.com  | Theo  | true

Columns are the headings: `id`, `email`, `name`, `email_verified`.

Rows are the entries: one per person.

A **cell** is where a row meets a column — Mara's email is one cell.

(Real ids are long random strings like `cc512230-de30-44c7-a197-fd6a88cb3f3c`. I'm writing `u_mara` so the examples stay readable. More on why ids look like that later.)

That's the whole shape of a database. Grids of rows. Everything else is talking to them.

---

## Making a grid: CREATE TABLE

Before a grid can hold rows, you declare its columns. That's `CREATE TABLE`.

```sql
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at     timestamp with time zone NOT NULL DEFAULT now()
);
```

Read it as a sentence: "make a grid called `users`, with these columns."

Each line inside the parentheses is one column, and it has three parts:

    email          text          NOT NULL
    ^ the name     ^ the type    ^ the rules

The **name** is the heading. The **type** is what kind of value the cell may hold. The **rules** are promises the database will enforce.

Let me name the types you'll actually use:

- `text` — a string of any length. `'mara@example.com'`.
- `boolean` — `true` or `false`.
- `integer` — a whole number. `42`.
- `timestamp with time zone` — a moment in time that knows its timezone.
- `uuid` — a long random identifier.

And the rules:

- `NOT NULL` — this cell can never be empty. (`NULL` is SQL's word for "no value at all." `NOT NULL` forbids it. More on `NULL` soon — it's sneakier than it looks.)
- `DEFAULT <value>` — if nobody supplies this cell, fill it with this. `email_verified` defaults to `false`; `created_at` defaults to `now()` (the current time, stamped automatically).
- `PRIMARY KEY` — this column is the row's unique name-tag. No two rows may share one, and it's the fast way to find a single row.

One line that trips people up:

```sql
id uuid PRIMARY KEY DEFAULT gen_random_uuid()
```

`uuid` is the **type** — what the cell holds. `gen_random_uuid()` is a **function** — it produces a fresh random id each time it runs. So the column *holds* a uuid, and its *default* is "call this function to make one." That's why we never invent ids by hand — insert a row, and the database mints its `id`. Random uuids almost never collide, so two servers can both create rows and never clash. That's the whole reason to prefer them over a counter like `1, 2, 3`.

---

## Putting a row in: INSERT

The grid exists but it's empty. `INSERT` adds a row.

```sql
INSERT INTO users (email, name) VALUES ('mara@example.com', 'Mara');
```

"Into the `users` grid, in the `email` and `name` columns, put these values."

Notice what I *didn't* write: no `id`, no `email_verified`, no `created_at`. I left them out on purpose, and the defaults filled them in — a fresh uuid, `false`, and the current time. The row that lands is complete:

    id       | email             | name  | email_verified | created_at
    ---------+-------------------+-------+----------------+---------------------
    u_mara   | mara@example.com  | Mara  | false          | 2026-07-08 09:14:...

You can insert several rows at once:

```sql
INSERT INTO users (email, name) VALUES
  ('sam@example.com',  'Sam'),
  ('theo@example.com', 'Theo');
```

Now the grid has three rows. Let's ask for them back.

---

## Asking for it back: SELECT ... FROM ... WHERE

This is the sentence you'll write more than any other. It has three parts, and each answers one question.

```sql
SELECT email, name          -- which COLUMNS do I want?
FROM users                  -- from which GRID?
WHERE email_verified = true -- which ROWS?
```

Read it top to bottom:

    SELECT   →  which columns
    FROM     →  which grid
    WHERE    →  which rows

`SELECT *` means "every column" (the `*` is "all"). `SELECT email, name` means just those two.

`FROM users` picks the grid.

`WHERE email_verified = true` is the filter. Only rows where that's true come back.

So that query returns Mara and Theo (verified), not Sam (not verified):

    email             | name
    ------------------+------
    mara@example.com  | Mara
    theo@example.com  | Theo

Change the question by changing the `WHERE`. Want just Sam?

```sql
SELECT * FROM users WHERE email = 'sam@example.com';
```

The database walks the grid, keeps the rows the `WHERE` approves of, and hands back the columns the `SELECT` asked for. That loop — filter rows, pick columns — is 80% of SQL.

---

## WHERE is where the thinking happens

The `WHERE` clause is a yes/no test run against every row. The row stays if the test is true.

You have the comparisons you'd expect:

```sql
WHERE created_at > '2026-01-01'          -- after a date
WHERE name = 'Mara'                      -- exactly equal
WHERE name != 'Mara'                     -- not equal
```

And you can combine tests with `AND` and `OR`:

```sql
SELECT * FROM users
WHERE email_verified = true
  AND created_at > '2026-01-01';
```

"Verified **and** created this year." A row must pass both.

`OR` means either is enough:

```sql
WHERE name = 'Mara' OR name = 'Sam';
```

Now, the sneaky one. `NULL` — the "no value at all" from earlier — does not behave like a value.

Here's the trap:

```sql
-- ✗ this returns NOTHING, even for rows where name really is empty
SELECT * FROM users WHERE name = NULL;
```

You'd expect it to find the rows with no name. It finds none.

Why? Because `NULL` means *unknown*, and "is this unknown thing equal to unknown?" isn't `true` — it's itself unknown. So the row fails the test. `= NULL` can never be true for anyone.

The fix is a special operator that asks the question directly:

```sql
-- ✓ the right way to ask "is this cell empty?"
SELECT * FROM users WHERE name IS NULL;
```

`IS NULL` and `IS NOT NULL` are how you test for emptiness. Reach for `=` and you'll silently get nothing back. This bites everyone once.

---

## Sorting and limiting: ORDER BY, LIMIT

Rows come back in no guaranteed order unless you ask for one. `ORDER BY` sorts them.

```sql
SELECT name, created_at FROM users
ORDER BY created_at DESC;
```

`DESC` = descending, newest first. `ASC` = ascending, oldest first (and it's the default).

`LIMIT` caps how many rows come back:

```sql
SELECT name FROM users
ORDER BY created_at DESC
LIMIT 1;
```

"The single most recently created user." Sort newest-first, then take one.

That pairing — `ORDER BY` then `LIMIT` — is how you get "the latest," "the top 10," "the most recent 5."

---

## Changing a row: UPDATE (and the WHERE you must never forget)

`UPDATE` changes cells in rows that already exist.

```sql
UPDATE users
SET email_verified = true
WHERE email = 'sam@example.com';
```

"In the `users` grid, set `email_verified` to true, **for the row where** email is Sam's."

The `SET` says what to change. The `WHERE` says *which rows* — and it is the most important word in the statement.

Here's the mistake that has ruined real production databases:

```sql
-- ✗ NO WHERE — this verifies EVERY user in the table
UPDATE users SET email_verified = true;
```

No `WHERE` means "every row." You meant to update Sam. You just marked all three million users as verified, in one keystroke, with no undo.

The rule burns itself into you fast: **an UPDATE without a WHERE hits everything.** Write the `WHERE` first.

---

## Removing a row: DELETE

`DELETE` throws rows away. Same lesson, sharper.

```sql
DELETE FROM users WHERE email = 'theo@example.com';
```

"Remove the row where email is Theo's." Theo is gone.

And the same landmine:

```sql
-- ✗ NO WHERE — this empties the entire table
DELETE FROM users;
```

No `WHERE`, no survivors. Every row, gone.

So for both `UPDATE` and `DELETE`, the `WHERE` is not optional decoration. It's the difference between "change one thing" and "change everything." A good habit: write the `WHERE` before you write the `SET` or the `DELETE`, so the target exists before the action does.

---

## Rows that point at other rows: the foreign key

So far, one grid at a time. But real data connects.

A membership connects a user to a team. So there's a third grid, `team_members`, that sits between `users` and `teams`. Each row says "this user is in this team, with this role":

```sql
CREATE TABLE team_members (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    text NOT NULL DEFAULT 'member'
);
```

Look at `team_id`. On its own it's just a uuid sitting in a cell. Nothing yet forces it to match a *real* team. The `REFERENCES teams(id)` is what forces it. That is a **foreign key**.

Read it in plain English:

    the team_members.team_id column
    must always REFERENCE a real teams.id
    — you can't have a membership pointing at a team that doesn't exist.

That's the whole idea of a foreign key: a column whose value must exist as a real row in another grid. Try to insert a membership for a team id that isn't there, and the database refuses. It's the rule that keeps the grids honest with each other — no memberships floating in space, pointing at nothing.

A foreign key is what turns a pile of separate grids into a connected web.

---

## When the row I point at is deleted, what happens to me?

A foreign key raises a question the moment you try to delete something.

Say you delete the *Design crew* team. What should happen to the membership rows that point at it? They can't keep pointing at a team that's gone — that's the exact thing the foreign key forbids.

So every foreign key must answer one question:

    When the row I point at is deleted, what happens to me?

You answer it with `ON DELETE`. There are two answers you'll reach for.

**`ON DELETE CASCADE` — "delete me too."**

```sql
team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE
```

Delete a team, and all its membership rows vanish with it. Delete a user, and all *their* membership rows vanish. No orphaned memberships pointing at a deleted team or a deleted user. Clean. The deletion *cascades* — it flows down the chain from the parent to the rows that depend on it.

**`ON DELETE SET NULL` — "don't delete me, just blank the pointer."**

Here's a different case. A team remembers who created it:

```sql
CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  created_by_id uuid REFERENCES users(id) ON DELETE SET NULL
);
```

Now delete the user who created *Design crew*.

You do **not** want the team to vanish — other people are still in it. So `ON DELETE SET NULL` says: keep the team, just set `created_by_id` to `NULL`. The pointer goes blank; the row lives on. The team outlives its creator.

That single word — `CASCADE` versus `SET NULL` — is the entire difference between "the child dies with the parent" and "the child survives, forgetting the parent." It's worth pausing on, because getting it wrong means either orphaned rows or accidental mass-deletion.

    parent row deleted
    ↓
    CASCADE   → the rows pointing at it are deleted too
    SET NULL  → the rows survive, their pointer set to NULL

(You may notice `created_by_id` has no `NOT NULL`. It can't — `SET NULL` needs to be *allowed* to write a blank there. The two rules go together.)

---

## Two grids, one question: JOIN

Now the payoff. Data lives in separate grids, but questions cross them.

"Which teams is Sam in?" The answer needs `team_members` (who's in what) *and* `teams` (the team's name). One grid can't answer it alone.

A `JOIN` stitches two grids together on a matching column.

```sql
SELECT teams.name, team_members.role
FROM team_members
JOIN teams ON team_members.team_id = teams.id
WHERE team_members.user_id = 'u_sam';
```

Read the `JOIN ... ON` as: "glue each `team_members` row to the `teams` row where their ids match." The `ON` is the matching rule — `team_members.team_id = teams.id`.

For each membership row, the database finds the team it points at and lays the two rows side by side, into one wider row:

    teams.name    | team_members.role
    --------------+------------------
    Design crew   | member

Sam's membership pointed at *Design crew*; the join pulled in that team's `name`. Two grids, one combined answer.

You qualify columns with their grid — `teams.name`, `team_members.role` — because once two grids are joined, a bare `name` could be ambiguous. Say which grid you mean.

---

## The many-to-many, and why it needs a table in the middle

Why does `team_members` exist at all? Why not just... put the members on the team?

Because a user can be in **many** teams, and a team has **many** members. That's a *many-to-many* relationship, and neither grid can hold it alone. A `teams` row can't list an unbounded number of members in one cell. A `users` row can't list an unbounded number of teams.

So the relationship gets its own grid. Each row is one "this user is in this team" fact. That middle grid is a **join table**, and you read it both directions:

    "Which teams is Sam in?"    → team_members rows where user_id = Sam
    "Who is in Design crew?"    → team_members rows where team_id = Design crew

One grid, both questions. This pattern — two things that relate many-to-many, joined by a table in the middle — is everywhere once you see it. Students and classes. Orders and products. Users and teams.

---

## INNER JOIN vs LEFT JOIN — the difference is who gets dropped

There's a fork in `JOIN` that matters, and the names hide it. Let me show the bug first.

You want a roster: every user, and their role if they're on a team.

```sql
-- looks right...
SELECT users.name, team_members.role
FROM users
JOIN team_members ON team_members.user_id = users.id;
```

Run it and Theo is **missing**.

    name  | role
    ------+--------
    Mara  | owner
    Sam   | member

Theo is in no team. A plain `JOIN` — an **inner** join — only keeps rows where *both* sides match. Theo has no `team_members` row, so he has nothing to match, so he falls out entirely. The join silently dropped him.

Sometimes that's what you want. Here it isn't — you wanted *every* user.

The fix is `LEFT JOIN`. It keeps every row from the left grid (`users`), matched or not. Where there's no match, it fills the right side with `NULL`:

```sql
SELECT users.name, team_members.role
FROM users
LEFT JOIN team_members ON team_members.user_id = users.id;
```

    name  | role
    ------+--------
    Mara  | owner
    Sam   | member
    Theo  | NULL     ← kept, with a blank role

Now Theo is there, his role `NULL` because he has none.

That's the whole distinction:

    INNER JOIN  → keep only rows that matched on both sides
    LEFT JOIN   → keep ALL left rows; NULL-fill the right where nothing matched

"Where did that row go?" in a report is, nine times out of ten, an inner join that should have been a left join.

---

## Counting: GROUP BY

One more kind of question: not "which rows" but "how many," per something.

"How many members does each team have?"

You don't want the rows themselves — you want a *count per team*. That's `GROUP BY`. It collapses rows that share a value into one group, and lets you count (or sum, or average) each group.

```sql
SELECT team_id, COUNT(*) AS member_count
FROM team_members
GROUP BY team_id;
```

`GROUP BY team_id` gathers all the rows with the same `team_id` into one bucket. `COUNT(*)` counts the rows in each bucket. `AS member_count` just names the output column.

    team_id       | member_count
    --------------+-------------
    t_design_crew | 2

`COUNT(*)` is the common one, but the same shape works with `SUM(...)`, `AVG(...)`, `MAX(...)`. The mental model: **`GROUP BY` turns many rows into one row per group, and the count/sum describes each group.**

---

## Making it fast: the index

Everything so far is about *correctness*. This one is about *speed*.

Ask "which teams is Sam in?" and, by default, the database reads **every single row** in `team_members` and checks each one's `user_id`. Three rows, fine. Three million rows, slow — every time.

An **index** fixes that. It's a lookup shortcut the database maintains on the side:

```sql
CREATE INDEX team_members_user_idx ON team_members (user_id);
```

Now "find Sam's memberships" jumps straight to his rows instead of scanning the whole grid — the same way the index at the back of a book beats flipping every page.

An index costs a little: it takes space, and it must be updated on every write. So you don't index every column — you index the ones you *look things up by*.

There's a second kind that does double duty:

```sql
CREATE UNIQUE INDEX team_members_team_user ON team_members (team_id, user_id);
```

A `UNIQUE` index is a shortcut **and a rule**: the pair `(team_id, user_id)` must be unique across the whole grid. Meaning the same user can't be in the same team twice. If two "add Sam to Design crew" requests arrive at the same instant, the database lets the first win and rejects the second — the uniqueness is enforced by the database, not by fragile "check, then insert" code that two requests can both slip through.

---

## All-or-nothing: the transaction

Last idea, and it's the one that separates toy SQL from real SQL.

Creating a team is really *two* writes: insert the team, then insert the membership that makes the creator its owner. Both have to happen, or the team is born broken — a team with no owner that nobody can manage.

Here's the danger, written the naive way:

```sql
INSERT INTO teams (name, created_by_id) VALUES ('Design crew', 'u_mara');
-- ... what if the process crashes RIGHT HERE? ...
INSERT INTO team_members (team_id, user_id, role) VALUES ('t_design_crew', 'u_mara', 'owner');
```

If the process dies between the two lines, the first row committed and the second never ran. Now there's a team with no members. A ghost.

A **transaction** fixes this. You wrap the statements so the database treats them as one indivisible unit — **all of them commit, or none of them do.**

```sql
BEGIN;
  INSERT INTO teams (name, created_by_id) VALUES ('Design crew', 'u_mara');
  INSERT INTO team_members (team_id, user_id, role) VALUES ('t_design_crew', 'u_mara', 'owner');
COMMIT;
```

`BEGIN` opens the transaction. `COMMIT` seals it — both rows land at the same instant. If anything between them fails, you `ROLLBACK` (or the database does it for you), and it's as if *neither* statement ever ran. The team can never exist without its owner.

    BEGIN
    ↓
    insert the team
    insert the owner membership
    ↓
    COMMIT  → both land together
       or
    ROLLBACK → neither happened, no ghost

That property — several changes that must be true *together* — is what transactions are for. Any time "do X" really means "do X and Y, and half of it would be a mess," wrap them.

---

## What SQL is not, and when to reach for something else

Two honest notes to end on.

SQL is not a general programming language you write loops in. It's *declarative*: you describe the rows you want, and the database figures out how to get them. You don't tell it "scan this grid, check each row" — you say `WHERE email_verified = true`, and *it* decides whether to use an index or scan. That flip — describe the result, don't script the steps — is the mental adjustment that makes SQL click.

And it's not always the right tool. If your data is a bag of loosely-shaped documents with no relationships — logs, a cache, a blob of JSON you always read whole — a relational database's grids and joins are overhead you don't need. SQL earns its keep exactly when your data *has* structure and *has* relationships: users who belong to teams that own documents, where a question crosses all three and the answer must stay consistent. That's the case these grids were built for.

The whole thing in three beats:

    A table is a grid, and SELECT ... WHERE is how you ask it questions.
    A foreign key connects two grids, and ON DELETE decides what a deletion drags with it.
    A transaction makes several writes land together, so your grids are never caught half-changed.
