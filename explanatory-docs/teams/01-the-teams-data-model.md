# How a team is shaped — two axes, two tables (and the migration, line by line)

> Increment: step 4 · M1 — the teams data model.
> Files: `src/db/schema.ts` (`teams`, `team_members`, the `team_role` and `team_access_level` enums),
> `drizzle/0004_wise_warbird.sql`.

"Team" is a word that means ten different things.

A chat room. A billing plan. A list of names. A folder.

Before writing a single column, I had to pin down which one this is.

Here it is, in one line:

    A team is a permission group. It answers two questions at once.

Those two questions are the whole design. Get them separate and the schema falls out on its own.

Let me follow one team the whole way.

Mara starts a team and calls it *Design crew*. Trace it.

---

## The two questions a team answers

Picture Mara adding her teammate Sam to *Design crew*.

Two completely different questions land at the same time.

**Question one — what can Sam do to the team itself?**

Can he invite other people? Rename it? Delete it? Or just... be in it?

**Question two — what can Sam do to the documents shared into the team?**

Read them? Edit them? Remove them?

These are not the same question. And that is the trap.

Here is the bad version — one field called `permission`:

```ts
// ✗ one knob for two independent things
type Membership = { permission: 'viewer' | 'editor' | 'admin' }
```

Watch it break.

Mara wants Sam to help *run* the team — invite people, rename it — but she only wants him to *read* the documents, not edit them.

With one knob, you cannot say that. "Admin" gives him edit rights he shouldn't have. "Viewer" strips the run-the-team rights he should have.

One field cannot hold two independent facts.

So we use two.

---

## Axis one: the role — power over the team

The **role** is Sam's authority over the team as a thing.

    owner   — can delete the team, change its access level, promote/demote members
    admin   — can invite and remove members, rename the team
    member  — can view it, and (later) share their own documents into it

Three values. Ordered. `owner` outranks `admin` outranks `member`.

That is the first axis.

## Axis two: the access level — power over the documents

The **access level** is set on the *team*, not the person. It is the ceiling on what *any* member may do to a document shared into that team.

    read    — members can open shared documents
    write   — ...and edit them
    delete  — ...and remove them from the team

Also three values. Also ordered: `read ⊂ write ⊂ delete`. Each is a superset of the one before.

One honest caveat, up front: **in this slice nothing enforces the access level yet.** It is stored the moment a team is created, but it only starts to *bite* later, when documents can actually be shared into teams. We store it now so a team is never missing its ceiling — not because anything reads it today.

So the two axes, side by side:

    role          governs the TEAM     (owner / admin / member)   — per member
    access level  governs the DOCUMENTS (read / write / delete)    — per team

A member's role and their team's access level move independently. That independence is exactly what the one-knob version couldn't express.

---

## Two tables, because a user and a team meet many-to-many

Now the shape.

A user can be in many teams. A team has many members. That is a **many-to-many** relationship, and you cannot store it on either side alone — a `teams` row can't list an unbounded number of members in one column, and a `users` row can't list an unbounded number of teams.

So the membership gets its own table sitting between them. Each row is one "this user is in this team, with this role" fact.

```ts
// src/db/schema.ts
export const teamsTable = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  accessLevel: teamAccessLevelEnum('access_level').notNull().default(TEAM_ACCESS_LEVELS.read),
  createdById: uuid('created_by_id').references(() => usersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const teamMembersTable = pgTable('team_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  teamId: uuid('team_id').notNull().references(() => teamsTable.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  role: teamRoleEnum('role').notNull().default(TEAM_ROLES.member),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

The picture:

    users ──1──<── team_members >──many──1── teams

Read the middle table both ways.

"Which teams is Sam in?" → the `team_members` rows where `user_id = Sam`.

"Who is in *Design crew*?" → the `team_members` rows where `team_id = Design crew`.

One table answers both.

---

## Who owns a team? Not `created_by_id`.

There is a subtle column here worth stopping on: `teams.created_by_id`.

You might assume that is the owner. It is not.

**Ownership is a membership row with `role = owner`.** `created_by_id` is a historical footnote — "who first clicked New team" — and nothing authorizes off it.

Why does the distinction matter? Because people leave.

Say Mara creates *Design crew*, adds Sam, promotes him to owner, and then deletes her own account. If ownership lived in `created_by_id`, the team would now point at a ghost.

Instead:

- `created_by_id` is `set null` when Mara is deleted — the column just goes blank.
- Sam's `owner` membership row is untouched.
- The team lives on, owned by Sam.

That is why `created_by_id` is the one user-reference in this whole schema that does **not** cascade-delete. Every other one (`team_members.user_id`, a document's owner) says "if the user goes, this row goes." This one says "if the user goes, forget who made it, but keep the team."

Hold that thought — it comes back the moment we actually create a team (doc 03), where the creator is seated as the first `owner` in the same breath as the team itself.

---

## The migration, line by line

Everything above is TypeScript. But Postgres doesn't speak TypeScript.

So `drizzle-kit generate` reads the schema and writes the equivalent **SQL** — the language the database actually runs. That file is `drizzle/0004_wise_warbird.sql`. Running `drizzle-kit migrate` feeds it to Postgres once, and the tables exist.

If you don't know SQL, that file looks like a wall. It isn't. It is six plain statements. Here it is, whole, then one piece at a time.

```sql
CREATE TYPE "public"."team_access_level" AS ENUM('read', 'write', 'delete');
CREATE TYPE "public"."team_role" AS ENUM('owner', 'admin', 'member');
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"access_level" "team_access_level" DEFAULT 'read' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "team_members_team_user_unique" ON "team_members" USING btree ("team_id","user_id");
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");
```

Read top to bottom, it does four things: makes two custom types, makes two tables, wires the tables together, then adds two lookups. Let's walk it.

### 1. The two `CREATE TYPE ... AS ENUM` lines

```sql
CREATE TYPE "public"."team_access_level" AS ENUM('read', 'write', 'delete');
CREATE TYPE "public"."team_role" AS ENUM('owner', 'admin', 'member');
```

`CREATE TYPE` invents a brand-new column type.

`AS ENUM('read', 'write', 'delete')` means: a value of this type may **only** ever be one of exactly those three strings. Not `'reed'`. Not `'READ'`. Not `'editor'`. The database itself rejects anything else.

Think of it as a drop-down menu baked into the column. You don't get to type a free answer; you pick one of the listed options.

Why bother, instead of a plain text column? Because a typo becomes impossible. If some buggy code tried to write `role = 'admn'`, Postgres refuses the write. The bad value can't get in.

(`"public"` is just the default namespace — the "schema" in Postgres's own sense — that ordinary tables live in. You can read past it every time it appears.)

### 2. `CREATE TABLE "team_members"`

```sql
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

A table is a grid. Columns are the headings; rows are the entries. `CREATE TABLE "team_members" ( ... )` declares the headings. Each line inside the parentheses is one column: its name, then its type, then some rules.

Go column by column.

`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL`

- `uuid` is the type — a long random identifier like `cc512230-de30-44c7-a197-fd6a88cb3f3c`. Every row gets its own.
- `DEFAULT gen_random_uuid()` means: if nobody supplies an id, Postgres generates a random one. So we never have to invent ids ourselves.
- `PRIMARY KEY` means this column is the row's unique name-tag. No two rows share one, and it's the fast way to find a single row.
- `NOT NULL` means the column can never be empty. (`NULL` is SQL's word for "no value at all." `NOT NULL` forbids it.)

`"team_id" uuid NOT NULL` and `"user_id" uuid NOT NULL`

- Two more uuids. One points at a team, the other at a user. Both required — a membership with no team, or no user, is nonsense, so it's forbidden. (What "points at" actually means is enforced a few lines down, by the foreign keys.)

`"role" "team_role" DEFAULT 'member' NOT NULL`

- The type is `"team_role"` — the custom drop-down we made in step 1. So this column can only hold `owner`, `admin`, or `member`.
- `DEFAULT 'member'` — add someone without saying which role, and they come in as a plain `member`, the least powerful. Safe by default.

`"created_at" timestamp with time zone DEFAULT now() NOT NULL`

- `timestamp with time zone` is a moment in time that remembers its timezone, so it's unambiguous anywhere on earth.
- `DEFAULT now()` stamps it with the current time automatically at insert. We never set it by hand.

### 3. `CREATE TABLE "teams"`

```sql
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"access_level" "team_access_level" DEFAULT 'read' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

Same shape, a few new pieces.

`"name" text NOT NULL` — `text` is a plain string of any length. A team must have a name, so `NOT NULL`.

`"access_level" "team_access_level" DEFAULT 'read' NOT NULL` — the other drop-down type. A new team defaults to `read`, the *safest* ceiling: members can look, nothing more, until someone deliberately raises it.

`"created_by_id" uuid` — look what's **missing**. No `NOT NULL`. This is the one nullable column in the two tables, and it's deliberate: when the creator's account is deleted, this goes blank (that's the "footnote, not owner" story from above). A column with no `NOT NULL` rule is allowed to hold `NULL`.

`updated_at` joins `created_at` because a team can be renamed later; the list sorts by "most recently touched," and that needs a field that moves.

### 4. The three `FOREIGN KEY` lines — wiring the tables together

```sql
ALTER TABLE "team_members" ADD CONSTRAINT "..." FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "team_members" ADD CONSTRAINT "..." FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "teams" ADD CONSTRAINT "..." FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
```

So far `team_id` is just a uuid sitting in a column. Nothing yet says it must match a *real* team. A **foreign key** is that promise.

`ALTER TABLE ... ADD CONSTRAINT` means "add a rule to an existing table." (`CONSTRAINT` is SQL's word for a rule; the long quoted name is just a label so error messages can point at it.)

Read the first one in plain English:

    the team_members.team_id column
    must always REFERENCE a real teams.id
    — you can't have a membership pointing at a team that doesn't exist.

That's a foreign key: a column whose value must exist as a real row in another table. It's what turns three loose tables into a connected graph.

Now the important half — `ON DELETE`. It answers: *when the row I point at is deleted, what happens to me?*

- `ON DELETE cascade` (both `team_members` keys) — "delete me too." Delete a team, and all its membership rows vanish with it. Delete a user, and all *their* membership rows vanish. No orphaned memberships pointing at a deleted team or a deleted user. Clean.
- `ON DELETE set null` (the `teams.created_by_id` key) — "don't delete me, just blank out the pointer." Delete the user who created a team, and the team **survives** with `created_by_id` set to `NULL`. This is the "team outlives its creator" rule, enforced by the database itself, in one word.

That single word — `cascade` versus `set null` — is the entire difference between "the team dies with its creator" and "the team lives on." It's worth the pause.

(`ON UPDATE no action` — ignore it. It's about what happens if a `users.id` ever *changed*, and ids never change here. Drizzle writes it for completeness.)

### 5. The two `CREATE INDEX` lines

```sql
CREATE UNIQUE INDEX "team_members_team_user_unique" ON "team_members" USING btree ("team_id","user_id");
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");
```

An **index** is a lookup shortcut. Without one, answering "which teams is Sam in?" means Postgres reads *every* row in `team_members` and checks each. With an index on `user_id`, it jumps straight to Sam's rows — like the index at the back of a book instead of flipping every page. (`USING btree` just names the kind of index; it's the default, good for this.)

The second line is exactly that speed-up for the sidebar's "my teams" query.

The first line is doing something sneakier. `CREATE **UNIQUE** INDEX` on `("team_id","user_id")` is a shortcut *and* a rule: the pair of values must be unique across the whole table. Meaning **the same user can't be in the same team twice.** If two "add Sam to Design crew" requests race at the same instant, the database lets the first win and rejects the second — no duplicate membership, decided by Postgres, not by fragile check-then-insert code.

That's the whole migration. Two drop-down types, two grids, three promises tying them together, two lookups — one of which quietly enforces "no duplicate members."

---

The five questions for this milestone:

**Where does this run?**

Entirely in Postgres. The migration is run once; nothing team-related touches the client here.

**What shape is the data?**

Two grids — a `teams` row (name + access level + timestamps) and `team_members` rows (one per person, each carrying a role).

**What gets stored?**

The team, and one membership row per member. The creator's ownership is a membership row, not a column.

**What's computed fresh?**

Nothing yet — this milestone is only the shape. Reads and writes arrive in docs 02 and 03.

**What's handed on?**

Two tables and two orthogonal enums that the authorization rule (doc 02) and the create flow (doc 03) both build on.

---

## When this shape is overkill

Two tables and two enums is more than a hobby project needs.

If "team" in your app just meant "a list of people who all see everything," you'd put a single array of user ids on some parent row and stop. No join table, no roles, no access levels.

We build the fuller shape because the two questions — *power over the team* and *power over the documents* — are genuinely independent here, and a real reviewer would immediately ask "can an admin be read-only?" With one knob, the answer is an embarrassed no. With two axes, it's yes.

The whole thing in three beats:

    The role decides what you can do to the team.
    The access level decides what the team can do to a document.
    The membership row is where a user and a team actually meet — and where ownership really lives.
