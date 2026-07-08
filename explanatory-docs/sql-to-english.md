# SQL → English cheat sheet

## Reading a SELECT

| SQL | English reading |
|---|---|
| `SELECT name FROM users` | from the `users` table, give me `name` for every row |
| `SELECT *` | every column |
| `SELECT name, email` | just these two columns |
| `SELECT DISTINCT country FROM users` | each `country` value once, no duplicates |
| `SELECT * FROM users u` | call `users` "`u`" for the rest of this query |
| `SELECT price AS cost` | output this column under the name `cost` |
| `SELECT COUNT(*) FROM users` | how many rows are in `users` |

## WHERE — which rows to keep

| SQL | English reading |
|---|---|
| `WHERE age = 18` | keep only rows where `age` is exactly 18 |
| `WHERE age != 18` | keep rows where `age` is anything but 18 |
| `WHERE age >= 18` | 18 or older |
| `WHERE is_verified AND is_active` | both must be true |
| `WHERE role = 'owner' OR role = 'admin'` | either one is enough |
| `WHERE NOT is_archived` | keep rows where `is_archived` is false |
| `WHERE role IN ('owner', 'admin')` | `role` is one of this list |
| `WHERE role NOT IN ('member')` | `role` is none of this list |
| `WHERE age BETWEEN 18 AND 30` | 18 to 30, endpoints included |
| `WHERE name LIKE 'A%'` | `name` starts with `A` |
| `WHERE name LIKE '%z'` | ends with `z` |
| `WHERE name LIKE '%an%'` | contains `an` |
| `WHERE name LIKE 'A_'` | `A` then exactly one more character |
| `WHERE name ILIKE 'a%'` | starts with `a`, ignoring upper/lowercase |

## NULL — the "no value" trap

| SQL | English reading |
|---|---|
| `NULL` | unknown — no value at all (not zero, not "") |
| `WHERE name IS NULL` | keep rows whose `name` is empty |
| `WHERE name IS NOT NULL` | keep rows that have a `name` |
| `WHERE name = NULL` | ✗ always matches nothing — `= NULL` is never true; use `IS NULL` |
| `COALESCE(name, 'Anon')` | `name`, or `'Anon'` when `name` is NULL (first non-null wins) |

## Sorting & paging

| SQL | English reading |
|---|---|
| `ORDER BY created_at` | sort by `created_at`, oldest first |
| `ORDER BY created_at DESC` | newest first |
| `ORDER BY last_name, first_name` | by `last_name`, then `first_name` to break ties |
| `LIMIT 10` | at most 10 rows |
| `LIMIT 10 OFFSET 20` | skip 20, then take 10 (page 3) |
| `ORDER BY created_at DESC LIMIT 1` | the single newest row |

## INSERT / UPDATE / DELETE

| SQL | English reading |
|---|---|
| `INSERT INTO users (email, name) VALUES ('mara@x.com', 'Mara')` | add one user with that email and name (other columns take their defaults) |
| `INSERT INTO users (email) VALUES ('a@x.com'), ('b@x.com')` | add two users at once |
| `UPDATE users SET name = 'Mara' WHERE id = 5` | change `name` to 'Mara', only in the matching row |
| `UPDATE users SET email_verified = true` | ✗ verify **every** user — no `WHERE`, no mercy |
| `DELETE FROM users WHERE id = 5` | remove the matching row |
| `DELETE FROM users` | ✗ empty the whole `users` table |
| `DELETE FROM users WHERE id = 5 RETURNING *` | delete it, and hand back the row you just removed |

## JOINs — combining two tables (multiple readings)

Example: `users` and their `documents` (`documents.owner_id` points at `users.id`; a user can own many documents, or none).

Every join answers one question: **a row found no match — does it survive?** The join word names who survives. A survivor with no partner gets `NULL` in the other table's columns.

| SQL | English reading |
|---|---|
| `users JOIN documents ON documents.owner_id = users.id` | only matched user–document pairs survive<br>· "for each document, attach its owner"<br>· no match → dropped, from either table |
| `users LEFT JOIN documents ON documents.owner_id = users.id` | **every user survives**; a user with no documents still appears, with `NULL` in the document columns<br>· "all users, plus their docs where they exist" |
| `users RIGHT JOIN documents ON documents.owner_id = users.id` | **every document survives**; a document with no matching user gets `NULL` in the user columns<br>· mirror of LEFT — same as `documents LEFT JOIN users` |
| `users FULL JOIN documents ON documents.owner_id = users.id` | **everybody survives**, from both tables; `NULL` wherever either side has no match |
| `users CROSS JOIN documents` | every user paired with every document — all combinations, no matching |
| `employees e JOIN employees m ON e.manager_id = m.id` | join a table to itself: each employee beside their manager |
| `users LEFT JOIN documents ON documents.owner_id = users.id WHERE documents.id IS NULL` | the users who own **no** documents — LEFT keeps them all, then keep only the ones whose document side came back `NULL` |

Memory hook: `ON` decides who matches · the join word decides who survives without a match · `NULL` fills the missing side.

Reminder: `OUTER` is an optional word — `LEFT JOIN` = `LEFT OUTER JOIN`.

## GROUP BY & aggregates (multiple examples)

`GROUP BY` collapses rows that share a value into one row per group; the aggregate describes each group.

| SQL | English reading |
|---|---|
| `GROUP BY team_id` | make one output row per distinct `team_id` |
| `SELECT team_id, COUNT(*) ... GROUP BY team_id` | how many rows in each team |
| `SELECT team_id, SUM(amount) ... GROUP BY team_id` | total `amount` per team |
| `SELECT team_id, AVG(score) ... GROUP BY team_id` | average `score` per team |
| `SELECT team_id, MAX(created_at) ... GROUP BY team_id` | the latest `created_at` per team |
| `COUNT(email)` | count rows where `email` isn't NULL (vs `COUNT(*)` = all rows) |
| `COUNT(DISTINCT user_id)` | how many **different** users |
| `GROUP BY team_id, role` | one row per (team, role) combination |
| `GROUP BY team_id HAVING COUNT(*) > 5` | keep only the **groups** with more than 5 rows (filter after grouping) |
| `WHERE ...` vs `HAVING ...` | `WHERE` filters rows **before** grouping; `HAVING` filters groups **after** aggregating |

## CREATE TABLE — column rules (constraints)

| SQL | English reading |
|---|---|
| `name text` | a `name` column holding any string |
| `age integer` | a whole number |
| `is_active boolean` | true / false |
| `id uuid` | a long random identifier |
| `created_at timestamptz` | a moment in time (with timezone) |
| `NOT NULL` | this cell can never be empty |
| `DEFAULT false` | if no value is given, use `false` |
| `DEFAULT now()` | if not given, stamp the current time |
| `PRIMARY KEY` | the row's unique name-tag — unique + not null + fast to find |
| `UNIQUE` | no two rows may share this value (multiple `NULL`s are still allowed) |
| `UNIQUE (team_id, user_id)` | no two rows may share this **pair** (each user only once per team) |
| `CHECK (age >= 0)` | reject any row where this isn't true |
| `team_id uuid REFERENCES teams(id)` | `team_id` must be a real `teams.id` — a foreign key |

## Foreign keys — ON DELETE (multiple readings)

A foreign key lives on the row that **points**. Example: a `team_members` row points at a `teams` row through `team_id`. `ON DELETE` decides what happens to **me, the pointing row,** when the row I point to is deleted.

| SQL | English reading |
|---|---|
| `team_members.team_id REFERENCES teams(id)` | a `team_members` row must point at a real `teams` row — never at nothing |
| `... ON DELETE CASCADE` | delete a team → also delete every `team_members` row that points at it<br>· "when the row I point to is deleted, delete me too" |
| `teams.created_by_id REFERENCES users(id) ON DELETE SET NULL` | delete the creator → keep the team, set its `created_by_id` to `NULL`<br>· "when the row I point to is deleted, keep me — just blank my pointer" |
| `... ON DELETE RESTRICT` | refuse to delete a `teams` row while any `team_members` row still points at it<br>· "you can't delete what I still point to" |
| `... ON DELETE NO ACTION` | same effect as RESTRICT — block the delete (checked at the end of the statement) |

## Indexes

| SQL | English reading |
|---|---|
| `CREATE INDEX ON team_members (user_id)` | keep a lookup shortcut so "find by `user_id`" is fast (no full-table scan) |
| `CREATE UNIQUE INDEX ON team_members (team_id, user_id)` | a shortcut **and** a rule: `(team_id, user_id)` must be unique |
| `CREATE INDEX ON events (user_id, created_at)` | shortcut for looking up by `user_id`, or by `user_id` **then** `created_at` (column order matters) |

## Transactions

| SQL | English reading |
|---|---|
| `BEGIN;` | start a transaction — hold the next changes together |
| `COMMIT;` | make all of them land at once |
| `ROLLBACK;` | undo everything since `BEGIN` — as if none of it happened |
| `BEGIN; … COMMIT;` | do all of these as one indivisible unit: all, or nothing |
