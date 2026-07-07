# Creating a team — the transaction that makes you its owner

> Increment: step 4 · M3 — the team REST routes.
> Files: `src/teams/routes.ts` (`POST /teams`, `GET /teams`, `GET /teams/:teamId`),
> `src/teams/teams.ts` (`createTeam`, `listTeamsForUser`, `getTeamForMember`), `src/server.ts`.

Creating a team sounds like one thing.

It's actually two things that must happen together, or the team is born broken.

That "or else" is the whole story of this milestone. Let me show you the broken version first, because it's the version you'd write by accident.

Mara clicks **New team**, types *Design crew*, hits enter. Trace the request.

---

## The request lands: one small route

The button fires `POST /teams` with a name. The route is deliberately thin:

```ts
// src/teams/routes.ts
app.post('/', async (req, reply) => {
  const { userId } = getAuthUser(req)
  const input = parseOrThrow(createTeamBody, req.body)
  const team = await createTeam({
    name: input.name,
    accessLevel: input.accessLevel,
    creatorId: userId,
  })
  return reply.code(201).send({ team })
})
```

`getAuthUser(req)` gives us Mara's id — the whole `/teams` plugin sits behind the same session hook the documents routes use, so an unauthenticated request is already rejected with `401` before this handler runs.

`parseOrThrow` validates the body: a name that's present and non-blank, and an optional access level that must be one of the three real values. Junk is a `400` here, before any database work.

Then it hands off to `createTeam`. That's where the interesting part lives.

---

## The broken version: two inserts, and a team with no owner

Creating a team means writing two rows:

1. the `teams` row itself, and
2. a `team_members` row seating Mara as its `owner`.

Remember the rule from doc 01: **ownership is a membership row, not the `created_by_id` column.** So a team without an owner-membership isn't "a team with a missing detail" — it's a team nobody can manage.

Here's the version you'd write without thinking:

```ts
// ✗ two independent writes
const team = await db.insert(teamsTable).values({ name, createdById: creatorId }).returning()
await db.insert(teamMembersTable).values({ teamId: team.id, userId: creatorId, role: 'owner' })
```

Looks fine. Now imagine the process dies between the two lines. Or the second insert hits a constraint and throws. Or the database connection drops for that one statement.

The first row committed. The second never happened.

Now there's a `teams` row with **no members at all**.

Nobody owns it. Nobody can rename it, change its access level, or delete it — every one of those routes authorizes off a membership row, and there are none. Mara can't even see it in her sidebar (the list is built from *her memberships*, and she has none for this team). It's a ghost team: real in the database, invisible and un-killable through the app.

That's not a rare edge case you can shrug off. It's a data-integrity hole that a crash at the wrong microsecond punches open.

## The fix: one transaction — both rows, or neither

The two writes have to be **atomic**: all-or-nothing, indivisible.

That's what a database **transaction** is. You wrap several statements in `db.transaction(...)`, and Postgres treats them as a single unit. Either every statement inside commits together, or — if anything throws — Postgres rolls the whole thing back as if none of it ever ran.

There is no in-between state where the team exists but its owner doesn't.

```ts
// src/teams/teams.ts
export const createTeam = async (input: {
  name: string
  accessLevel: TeamAccessLevel | undefined
  creatorId: string
}): Promise<TeamSummary> => {
  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teamsTable)
      .values({ name: input.name, accessLevel: input.accessLevel, createdById: input.creatorId })
      .returning()
    if (team === undefined) {
      throw new Error('team insert returned no row')
    }
    await tx
      .insert(teamMembersTable)
      .values({ teamId: team.id, userId: input.creatorId, role: TEAM_ROLES.owner })
    return toTeamSummary(team)
  })
}
```

Read it as a sentence.

Open a transaction.

Insert the team; keep the row it hands back (we need its fresh id).

Insert the membership that seats the creator as `owner`, pointing at that id.

Return the team. The transaction commits *here*, at the end — both rows land at the same instant.

If the membership insert had thrown, the `return` never runs, the transaction rolls back, and the `teams` row you saw a line earlier is erased. No ghost. The invariant "a team always has an owner" isn't a thing we hope holds — it's a thing the transaction *makes* hold.

One small detail: `accessLevel: undefined`. Passing `undefined` omits the column entirely, so the database's own `DEFAULT 'read'` applies (that's the migration line from doc 01). Mara didn't pick a level, so she gets the safest one, decided in exactly one place — the schema.

The flow, end to end:

    Mara clicks New team
    ↓
    POST /teams  { name: "Design crew" }        (401 if not signed in, 400 if the name is blank)
    ↓
    createTeam — inside ONE transaction:
        insert the teams row
        insert the owner membership
    ↓  both commit together, or neither does
    201 { team }
    ↓
    Design crew appears in Mara's sidebar, owned by her

---

## Seeing it back: the list and the single team

Two read routes round out the slice, and both lean on work from doc 02.

`GET /teams` is the sidebar. It returns the teams Mara is a member of — and the membership join *is* the filter, so a team she isn't in simply can't appear:

```ts
// src/teams/teams.ts — listTeamsForUser
.from(teamMembersTable)
.innerJoin(teamsTable, eq(teamMembersTable.teamId, teamsTable.id))
.where(eq(teamMembersTable.userId, userId))
.orderBy(desc(teamsTable.updatedAt))
```

It starts *from* her memberships and joins out to the teams, newest-touched first. Each row carries her role in that team, so the client never has to ask "and what am I here?" separately.

`GET /teams/:teamId` is one team. It calls `getTeamForMember` — the join-as-authorization query from doc 02 — and turns a missing row into a `404`:

```ts
// src/teams/routes.ts
const membership = await getTeamForMember({ teamId, userId })
if (membership === null) {
  throw notFound('team_not_found', 'Team not found.')
}
const { role, ...team } = membership
return { team, role }
```

A stranger asking for *Design crew* by id matches no row and gets a `404` — the same answer as a team that never existed. No oracle. (That's the rule doc 02 is entirely about; here it's just... used.)

The `role` is split back out of the joined row so the client receives a clean team object plus, separately, the caller's own role — which will later decide whether the page shows a "Delete team" button or hides it.

---

The five questions for this milestone:

**Where does this run?**

The server. Three Fastify routes over Postgres; the client just POSTs a name and renders what comes back.

**What shape is the data?**

In: a team name (+ optional access level). Out: a team summary — id, name, access level, timestamps — and, on the reads, the caller's role.

**What gets stored?**

Two rows per creation, in one transaction: the team, and the creator's `owner` membership. Never one without the other.

**What's computed fresh?**

Every read is a live, membership-scoped query — the sidebar list and the single-team fetch are recomputed per request, never cached.

**What's handed on?**

A created team the caller owns, and a `{ team, role }` shape the frontend's TeamPage (a later pass) uses to gate its controls.

---

## When a transaction is overkill

Transactions aren't free to reach for, and they're not always warranted.

If creating a team were a *single* insert — no membership row, no second write — you wouldn't wrap it in a transaction. A lone statement is already atomic on its own; Postgres either writes the row or it doesn't.

The transaction earns its place here for one specific reason: **two writes that must be true together.** The moment "create X" means "and also create the Y that makes X usable," you want them fused, so a failure halfway can't leave a half-built thing behind.

The whole thing in three beats:

    The route is thin — authenticate, validate, delegate.
    The transaction fuses the team and its owner into one atomic birth.
    The reads are membership-scoped, so you only ever see the teams you're actually in.
