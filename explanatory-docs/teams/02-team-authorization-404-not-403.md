# The authorization rule — a 404 that means "not yours"

> Increment: step 4 · M2 — the authz core + the team-scoped data layer.
> Files: `src/teams/authz.ts` (`getTeamRole`, `requireTeamRole`, `TEAM_ROLE_RANK`),
> `src/teams/teams.ts` (`getTeamForMember`, `listTeamsForUser`).

Every team route has to answer the same question before it does anything:

    Is this caller allowed to touch this team — and if not, what do I tell them?

That second half is the part people get wrong.

The obvious answer leaks a secret. Let me show you the leak, then the fix.

Follow one request. Sam — who is *not* in Mara's *Design crew* — asks the server for it by id.

---

## The leak: a 403 confirms the team exists

Here's the naive guard.

```ts
// ✗ leaks existence
const role = await getTeamRole({ teamId, userId: sam })
if (role === null) {
  throw forbidden('not_a_member', 'You are not a member of this team.')   // 403
}
```

Sam gets `403 Forbidden`.

Read what `403` actually tells him.

`403` means "this exists, and you can't have it." So Sam now *knows* there is a real team at that id. He guessed an id, and the server confirmed it.

Do that in a loop and you can map out which team ids are real without being in a single one of them. The error code became an oracle — a machine that answers yes/no about things you're not allowed to see.

For a document-review tool, "which teams exist and how many" is exactly the kind of thing that should stay invisible to outsiders.

## The fix: 404 for outsiders, 403 only for insiders

The rule is two failure modes, two different codes, and the split is the whole point.

    not a member at all      → 404 Not Found      (indistinguishable from "no such team")
    a member, but under-rank  → 403 Forbidden      (you're in it — you already know it exists)

`404` says nothing. To Sam, a team he's excluded from and a team that was never created look *identical*. No oracle.

`403` is now safe to use — but only for someone who is *already inside* the team. If Mara made Sam a plain `member` and he tries to do an owner-only thing, `403` leaks nothing: he obviously knows the team exists, he's standing in it.

Here's the guard that encodes it — the one seam every team mutation will reuse:

```ts
// src/teams/authz.ts
export const requireTeamRole = async (input: {
  teamId: string
  userId: string
  atLeast: TeamRole
}): Promise<TeamRole> => {
  const role = await getTeamRole({ teamId: input.teamId, userId: input.userId })
  if (role === null) {
    throw notFound('team_not_found', 'Team not found.')          // outsider → 404
  }
  const meetsFloor = TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK[input.atLeast]
  if (!meetsFloor) {
    throw forbidden('insufficient_team_role', '...')             // insider, too low → 403
  }
  return role
}
```

`getTeamRole` returns the caller's role, or `null` if they hold no membership row. `null` is the outsider. Everything downstream keys off that one distinction.

---

## Why the rank lives in a TypeScript map, not in SQL

Look at `meetsFloor`:

```ts
const meetsFloor = TEAM_ROLE_RANK[role] >= TEAM_ROLE_RANK[input.atLeast]
```

To ask "is `owner` at least a `member`?" you need the roles to be *numbers* you can compare. So there's a rank map:

```ts
// src/teams/authz.ts
export const TEAM_ROLE_RANK: Record<TeamRole, number> = {
  [TEAM_ROLES.member]: 1,
  [TEAM_ROLES.admin]: 2,
  [TEAM_ROLES.owner]: 3,
}
```

You might reach for a shortcut here. Postgres enums *already* have an internal order — the order you listed them in when you wrote `CREATE TYPE`. Couldn't you just compare the enum values directly in SQL and skip the map?

You could. It's a trap.

That would tie "who outranks whom" — a real authorization rule — to the *declaration order* of an enum. Reorder the enum for some unrelated reason, or add a new role in the middle, and you'd silently invert who's allowed to delete a team. The security rule would move because someone tidied a list.

So the rank is spelled out in code, as data, where it reads as what it is: a domain rule. And it's typed `Record<TeamRole, number>`, which means if a fourth role is ever added and *not* given a rank, the code won't compile. A missing rank is a build error, not a silent `undefined` that quietly ranks the new role at the bottom.

    enum order is incidental.
    authorization is not.
    so authorization does not ride on enum order.

---

## The read path: the join *is* the authorization

There's a second, quieter version of the same idea in how a single team is fetched.

You could fetch the team, then check membership in code:

```ts
// ✗ two steps, and a fetch that can see a team you're not in
const team = await getTeamById(teamId)
const role = await getTeamRole({ teamId, userId })
if (role === null) throw notFound(...)
```

Instead, one query asks both questions at once — "does this team exist *and* is this user in it?" — by joining the team to the caller's membership row:

```ts
// src/teams/teams.ts — getTeamForMember
.from(teamsTable)
.innerJoin(
  teamMembersTable,
  and(eq(teamMembersTable.teamId, teamsTable.id), eq(teamMembersTable.userId, input.userId)),
)
.where(eq(teamsTable.id, input.teamId))
```

An `innerJoin` only returns a row when *both* sides match — the team exists **and** this user has a membership in it. A non-member matches nothing. A bad id matches nothing. Both come back as "no row," which the route turns into the same `404`.

This is the identical trick the documents layer already uses — there the `WHERE ownerId = you` clause *is* the permission check, not an `if` after the fetch. Same idea here: the authorization is baked into the query, so there's no window between "check membership" and "read the team" for the two to disagree, and no code path that can accidentally hand back a team the caller isn't in.

Where each piece runs, and what it hands on:

    getTeamRole        → Postgres → the caller's role, or null
    requireTeamRole    → wraps getTeamRole → the role (guaranteed ≥ a floor), or throws 404 / 403
    getTeamForMember   → one joined query → the team + the caller's role, or null → route says 404

---

The five questions for this milestone:

**Where does this run?**

The server. Every check is a small indexed lookup in Postgres; the client only ever sees the resulting status code.

**What shape is the data?**

A single membership row (or its absence). `getTeamRole` reads just the `role` column; the outsider case is simply "no row."

**What gets stored?**

Nothing new — this milestone only *reads*. It's the rule, not the write.

**What's computed fresh?**

The role lookup, on every guarded request. Authorization is never cached here; it's asked live each time.

**What's handed on?**

`requireTeamRole` — the one guard the member-management routes (a later pass) call on nearly every mutation — and `getTeamForMember`, which [doc 03](./03-creating-a-team.md)'s `GET /teams/:teamId` uses directly.

---

## Honest about what this slice does *not* do

Two limits worth stating plainly.

`requireTeamRole` is built and unit-tested here, but **none of this slice's three routes actually call it yet** — creating, listing, and viewing a team don't gate on rank. It exists now because the `404`-vs-`403` split *is* milestone 2's whole point, and its first real consumer (removing a member, changing a role) is the very next pass. Building and testing the seam now means that pass adds routes, not security primitives.

And the access level from [doc 01](./01-the-teams-data-model.md) still isn't enforced by anything — it can't be until documents can be shared into teams. This milestone is about *who is in a team and how much they outrank*, not yet *what a team can do to a document*.

The whole thing in three beats:

    An outsider gets a 404, so the server never confirms a team they can't see.
    An under-ranked insider gets a 403, because they already know it exists.
    The rank that decides "under" lives in code, not in the accident of an enum's order.
