# The invites data model — a row that is nothing but a hash and an intent

> Increment: step 4 · M4 — team invites (schema).
> Files: `src/db/schema.ts` (`teamInvitesTable`, `TeamInviteRow`), `drizzle/0005_team_invites.sql`.

Mara owns *Design crew*. She wants Sam in it. Sam doesn't have an account yet — he isn't a row in `users`, he's just an email in Mara's head.

So we can't add Sam to the team. There's no `team_members` row to write, because there's no user to point it at.

What we can do is write down the *intention* to add him, in a way that turns into a real membership the moment Sam shows up and proves he's Sam. That written-down intention is an **invite**. This doc is about the single table that holds it, and why it looks the way it does.

---

## What an invite has to remember

Strip it to the essentials. To turn "Mara wants Sam in Design crew as a member" into a membership later, a row has to remember four things:

- **which team** — Design crew
- **which email** — sam@example.com
- **what role** he'll get — member
- **who invited him** — Mara (so we can show "invited by" and clean up if she's deleted)

Plus two bookkeeping columns every token-like row in this codebase carries: **when it expires** and **when it was created**.

Here's the whole table:

```ts
// src/db/schema.ts
export const teamInvitesTable = pgTable(
  'team_invites',
  {
    id: text('id').primaryKey(),                       // sha256(rawToken)
    teamId: uuid('team_id').notNull()
      .references(() => teamsTable.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),                    // lowercased in code
    role: teamRoleEnum('role').notNull(),
    invitedById: uuid('invited_by_id').notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('team_invites_team_email_unique').on(t.teamId, t.email),
    index('team_invites_team_idx').on(t.teamId),
  ],
)
```

Every column earns its place below. The two that look ordinary — `id` and the unique index — are the two doing the most work.

---

## The id is the hash, not an id

Look at the primary key: it's `text`, not the `uuid` primary key every other table in this schema uses. That's a deliberate tell.

The invite is unlocked by a **token** — a long random string that rides in the link we email Sam:

    https://app/invite?inviteToken=WarzgEBcgU3pBsMH2Kzv_Z0cM-xnTSS1C6GCB3kGrgk

We never store that raw token. We store `sha256(rawToken)` and use *that* as the primary key.

This is exactly the shape of `email_verification_tokens` and `password_reset_tokens` from the auth slice (see [doc 01](./01-the-teams-data-model.md) for the teams tables these sit beside). The reason is one sentence:

**A leak of the database must not hand the attacker a working invite link.**

If we stored the raw token, anyone who read the row could paste it into `?inviteToken=` and accept the invite as Sam. Storing only the hash breaks that: sha256 is one-way, so a stolen row is a dead end — you can't run the hash backwards to recover the link.

When Sam's real link arrives, accepting it is a lookup: hash the token he presents, find the row whose `id` equals that hash. No row, or a different hash, means no invite. The token in his inbox is the only copy of the key that exists, and it exists nowhere on our side.

```
    raw token  ──sha256──▶  id (stored)
    (in the email,            (in the DB,
     never stored)            never reversible)
```

`generateToken()` and `hashToken()` — the same two functions the auth tokens use — live in `src/auth/tokens.ts`. The invite table borrows them wholesale; there is no invite-specific crypto.

## Why sha256 here, and argon2 for passwords

A fair question: passwords in this app are hashed with argon2id (slow, salted, deliberately expensive). Invite tokens are hashed with plain sha256 (fast). Why the difference?

Because the threat is different. A password is *low-entropy* — people pick `hunter2` — so an attacker who steals the hash tries to brute-force it, and you want each guess to cost real time. An invite token is *high-entropy*: 32 random bytes, 256 bits. There is nothing to brute-force — you can't guess a 256-bit random string in the lifetime of the universe. So the slow hash buys you nothing here, and fast sha256 is exactly right. Match the tool to what the attacker can actually do.

---

## The unique index is a rule, not an optimization

The second `(t) => [...]` entry:

```ts
uniqueIndex('team_invites_team_email_unique').on(t.teamId, t.email)
```

This says: **at most one live invite per (team, email).** Mara can't have two outstanding invites for sam@example.com to Design crew. The database refuses the second row.

That isn't a performance tweak — it's a correctness rule the database enforces so the code doesn't have to. It makes "re-invite" mean something precise: not "add another invite" but "replace the one that's there." [Doc 06](./06-inviting-and-accepting.md) shows the delete-then-insert that leans on this key to rotate a token — and why that's the behaviour you want.

The plain (non-unique) index below it, on `teamId` alone, is the ordinary kind — it makes "list the outstanding invites for this team" (the admin's pending list) a fast lookup instead of a full-table scan.

`email` is stored **lowercased**. The app normalizes it (`normalizeEmail`, the same helper signup uses) before every insert and every compare, so `Sam@Example.com` and `sam@example.com` are one invitee against this unique key, not two. The uniqueness rule would be a lie if case slipped through.

---

## role: the enum, minus one value

`role` reuses `teamRoleEnum` — the `owner | admin | member` type from [doc 01](./01-the-teams-data-model.md). But an invite may only ever carry `admin` or `member`. **You cannot invite someone straight to `owner`.**

Nothing in *this table* enforces that — the column type still permits `owner`, because it's the shared enum. The restriction lives one layer up, in the route's validation ([doc 06](./06-inviting-and-accepting.md)). The table's job is to store a role; the rule "which roles are invitable" is a policy, and policy lives in code where it reads, not in a column type.

The reason for the rule is the invariant from [doc 03](./03-creating-a-team.md): a team's owner is established at creation and changes only by deliberate promotion. Ownership is too consequential to hand out through an email link. A team gains an owner on purpose, never by accident of who clicked what.

---

## Two foreign keys, two different delete rules

Both `teamId` and `invitedById` are foreign keys, and they cascade on delete — but they're answering different questions.

- `teamId` → `teams`, **cascade**: delete the team, and its pending invites vanish with it. An invite to a team that no longer exists is meaningless.
- `invitedById` → `users`, **cascade**: delete the inviter, and their outstanding invites go too.

That second one is worth pausing on, because it's the *opposite* of the choice `teams.created_by_id` made. There ([doc 01](./01-the-teams-data-model.md)), deleting the creator uses `set null` — the team must survive its creator, because other people are in it. Here, an invite has no such life of its own: it's a transient, pending thing that only matters until it's accepted or expires. If the person who sent it is gone, there's no reason to keep a half-finished hand-off around. So it cascades.

Same word — "cascade" vs "set null" — but the choice each time comes from one question: *does this row have a reason to outlive the thing it points at?* A team does. A pending invite doesn't.

---

The five questions for this milestone:

**Where does this run?**

Postgres. One new table, one migration (`0005_team_invites`), no application logic yet — that's [doc 06](./06-inviting-and-accepting.md).

**What shape is the data?**

A row per outstanding invite: the token's hash as id, plus team, email, role, inviter, and expiry.

**What gets stored?**

Only the hash of the token — never the token itself — alongside the intent (who, where, what role). The raw token exists only in the email.

**What's computed fresh?**

Nothing here; this doc is the table. Acceptance turns a row into a membership later.

**What's handed on?**

A place to write "X is invited to team Y as role Z," keyed by a hash that only the real link can reproduce.

---

The whole model in three beats:

    An invite is an intention to add someone who isn't a user yet.
    The row stores the token's hash, never the token — a DB leak yields no working link.
    unique(team, email) makes "re-invite" mean "replace," and the enum minus 'owner' keeps ownership deliberate.

Next: [doc 06](./06-inviting-and-accepting.md) — how a raw token becomes a membership, and why the link itself is the only credential that matters.
