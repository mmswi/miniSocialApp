# Inviting and accepting — the link is the only credential

> Increment: step 4 · M4 — team invites backend + M8 — the invite-send form and the
> accept-through-login UI.
> Files: `src/teams/invites.ts` (`createTeamInvite`, `previewTeamInvite`, `acceptTeamInvite`,
> `sendTeamInviteEmail`), `src/teams/routes.ts` (`POST /:teamId/invites`, `POST /invites/accept`),
> `web/src/pages/DashboardPage.tsx` (the send form) with `API_createInvite` in `web/src/lib/api.ts`,
> `web/src/pages/InviteAcceptPage.tsx`, `web/src/lib/invite-link.ts`, and the token threading in
> `web/src/pages/{LoginPage,SignupPage,TwoFactorPage}.tsx`.

[Doc 05](./05-the-invites-data-model.md) built the table. This is the life of one invite through it: Mara invites Sam, an email lands, Sam clicks, Sam is in the team. Four steps, and at each one the interesting question is *what stops the wrong person here?*

The answer runs through the whole doc, so let me say it once up front:

**The invite token is a capability.** Whoever holds the raw token can accept the invite. Not "whoever is logged in as Sam" — whoever has the link. That sounds alarming until you see where the link comes from: Sam's inbox. Receiving the token *is* the proof. Everything below is built around that one fact.

---

## Step 1 — issuing the invite

Mara starts on her dashboard. Each team row she administers carries an **Invite** button; clicking it expands a small form right under the row — email, role, send (an inline expand, the same house pattern as the New-team form, not a modal). She types sam@example.com, picks *member*, hits **Send invite**, and the client calls `API_createInvite` — a `POST /teams/:teamId/invites` with just `{ email, role }`.

Two things about that form are decisions, not styling.

**The button only exists on rows Mara can act on.** A plain member's team row has no Invite control at all — role-gating by hiding, so the UI never offers a button whose only possible answer is `403`.

**The role list bends to who's asking.** An owner's form offers *Member* and *Admin*; an admin's form offers only *Member*. The option the server would refuse is never on screen.

But hiding is UX, not enforcement. The client's team list could be stale, and nothing stops a hand-crafted request from skipping the form entirely. So the route re-asks both questions itself, with authority, before any invite exists:

```ts
// src/teams/routes.ts — POST /:teamId/invites
const callerRole = await requireTeamRole({ teamId, userId, atLeast: TEAM_ROLES.admin })
if (input.role === TEAM_ROLES.admin && callerRole !== TEAM_ROLES.owner) {
  throw forbidden('invite_admin_requires_owner', 'Only an owner can invite an admin.')
}
```

First, **may Mara invite at all?** `requireTeamRole` (from [doc 02](./02-team-authorization-404-not-403.md)) demands admin-or-higher. A non-member gets a `404` — the same "this team may as well not exist" answer a stranger gets everywhere else, so the endpoint never confirms the team to someone outside it. A plain member gets a `403`: they're in the team, so hiding it would be pointless, but they can't invite.

Second, **may Mara grant *this* role?** `requireTeamRole` hands back her actual role, and the rule reads straight off it: conferring `admin` requires being an `owner`. An admin can invite members, but not mint another admin — a peer who could then turn around and remove them. Notice we didn't need a second query for this; the guard already told us who Mara is.

Then the invite is written:

```ts
// src/teams/invites.ts — createTeamInvite
if (await isEmailAlreadyMember({ teamId, email })) {
  throw conflict('already_member', 'That person is already a member of this team.')
}
const rawToken = generateToken()
await db.transaction(async (tx) => {
  await tx.delete(teamInvitesTable).where(
    and(eq(teamInvitesTable.teamId, teamId), eq(teamInvitesTable.email, email)))
  await tx.insert(teamInvitesTable).values({ id: hashToken(rawToken), teamId, email, role, invitedById, expiresAt })
})
return { rawToken, expiresAt }
```

Two things worth their lines here.

**The already-member check.** If sam@example.com is already in the team, there's nothing to invite — so we say so with a `409`, rather than minting an invite that would do nothing when accepted. It's a join: is there a `users` row for this email whose id also holds a membership in this team? (This is a friendliness guard, not a security boundary — a race could still slip one through, and accept handles that gracefully; see step 5.)

**Delete-then-insert, in one transaction.** Before inserting, we delete any existing invite for this `(team, email)`. That's what makes *re-inviting* well-defined against the unique key from [doc 05](./05-the-invites-data-model.md): re-inviting Sam doesn't stack a second invite, it **rotates** the token. The old link stops working the instant the new one is sent — because the old row (whose id was the old hash) is gone. If Mara worries the first link leaked, re-inviting is the fix, for free.

`createTeamInvite` returns the **raw token** — the only moment it exists on our side. The route hands it straight to the email and keeps nothing:

```ts
const { rawToken } = await createTeamInvite({ teamId, email, role, invitedById: userId })
await sendTeamInviteEmail({ to: email, teamName, rawToken })
return reply.code(201).send({ invite: { email, role, expiresAt } })   // no token in the response
```

The response tells the client *what* it created, but never the token. Back on the dashboard, Mara's form collapses into a note — *Invite sent to sam@example.com* — echoing the address the server actually stored (lowercased once, server-side, so the confirmation and the unique key agree on the same spelling). That note is everything the sender ever sees. The token goes to exactly one place: Sam's inbox.

---

## Step 2 — the email, and the durable queue behind it

`sendTeamInviteEmail` doesn't send anything itself. It hands a rendered message to the same BullMQ queue the auth emails use:

```ts
// src/teams/invites.ts
await enqueueEmail({
  to: input.to,
  subject: `You've been invited to join ${input.teamName} on redline`,
  text: `...${env.APP_URL}/invite?inviteToken=${rawToken}...`,
})
```

Enqueueing touches only Redis, so the invite request returns fast and can't fail because the mail provider hiccuped — a worker delivers the mail with retries. In dev the worker delivers into Mailpit (`http://localhost:8025`), so "Sam's inbox" is a browser tab on your own machine; under `bun test` there's no worker at all, and `enqueueEmail` delivers inline into an in-memory `sentEmails` array — that's the seam the tests read the token back out of. The one send seam and its three transports are [auth doc 08](../auth/08-the-email-pipeline-one-seam-three-transports.md).

The link points at `/invite?inviteToken=<raw>` — the frontend landing page (Step 4). The backend's job ends at "the raw token is in an email that's been handed to the queue"; what happens when Sam clicks it is the sign-in-and-accept flow the next steps trace.

---

## Step 3 — preview, before anyone is logged in

Sam clicks the link. He may not have an account. He may not be logged in. He should still see *what he's being invited to* before committing to signing up.

So preview is a **public** route — the one `/teams` route with no auth behind it:

```ts
// src/teams/invites.ts — previewTeamInvite
const invite = await findLiveInviteByToken(rawToken)
if (invite === null) {
  throw badRequest('invalid_invite', 'This invite link is invalid or has already been used.')
}
return invite   // { teamId, teamName, email, role }
```

How it can be public without leaking anything is a routing story of its own — [doc 07](./07-a-public-route-in-a-private-plugin.md) is entirely about that. Here, notice only *what* it returns: the team name, the role on offer, and the email the invite was sent to. All safe to show the holder of the token — they already have the link that was mailed to that address. The email is in there on purpose: it lets the page say "this invite is for sam@…, but you're logged in as theo@…" instead of silently failing at the last step.

`findLiveInviteByToken` is the shared resolver both preview and accept call, so they agree on what "valid" means. Its failure discipline is lifted straight from `verifyEmailToken` in the auth slice:

- **unknown or already-used token → `null`** → the caller answers `400 invalid_invite`. A consumed invite was *deleted*, so it has no row — indistinguishable from a token that never existed. Neither is an oracle.
- **expired → delete the row, throw `400 invite_expired`** → a distinct, honest answer ("ask for a new one"), and the dead row is cleaned up as a side effect of being looked at.

---

## Step 4 — Sam signs in, and the invite rides along

Step 3 showed Sam the invite while he was still a stranger: logged out, maybe without an account at all. But step 5's `accept` route opens with `getAuthUser(req)` — it needs a `userId`, and a `userId` only ever arrives on a **session**. So there's a gap between "looked at the invite" and "accepted it," and one thing fills it: **Sam signs in.**

Two cases, and they are *not* symmetric.

**Sam already has an account.** He logs in. `POST /auth/login` checks his password and calls `createSession` (`src/auth/session.ts`), the cookie is set, he's authenticated. One hop.

**Sam is brand new.** He signs up — and here's the catch you'd never guess from the outside: **signup does not open a session.** Look at `signupWithPassword` (`src/auth/password-auth.ts`); after creating the user it stops, and the comment says why — a *taken* email has no session to grant, so "sometimes a session" would itself be the enumeration oracle that the uniform signup is built to close. So a fresh invitee takes *two* hops: sign up (his `users` row and `userId` come into being), then log in (his session comes into being). Only after the second hop does the `userId` that `accept` will seat actually exist.

One thing he pointedly does **not** need: a *verified* email. Neither `login` nor `accept` gates on `emailVerified` — the verification link is for account recovery and safe auto-linking, not for this. The invite token in Sam's inbox is the proof that counts (that's the email-match in step 5). So he can accept the moment he's logged in, verified or not.

---

### Keeping the invite through the detour

The detour would be pointless if logging in dumped Sam on his dashboard with the invite forgotten. The whole flow rests on one property: **the token never leaves the URL.** The emailed link is `…/invite?inviteToken=RAW` — a query parameter, so it survives navigation and reloads (it isn't held in memory a redirect would wipe).

The frontend carries it end to end:

    /invite?inviteToken=RAW        ← the emailed link lands here (InviteAcceptPage — a PUBLIC route)
       ├─ logged in as the invitee?  →  POST /teams/invites/accept { token: RAW }   ✓ joined
       ├─ logged in as someone else? →  "wrong account" — offer to switch
       └─ logged out?                →  /login?inviteToken=RAW
                                          (or /signup?inviteToken=RAW → then login)
                                        ↓ after auth, navigate BACK to
                                     /invite?inviteToken=RAW
                                        → now the invitee → accept

`InviteAcceptPage` (`web/src/pages/InviteAcceptPage.tsx`) is that public `/invite` page — public because previewing has to work before there's a session. Finding the visitor logged out, it sends them to `/login?inviteToken=RAW`; `LoginPage` reads the token and, on success, returns to `/invite?inviteToken=RAW` instead of the dashboard. A 2FA account carries it through `/2fa` too, and the signup screen's login links carry it, so the sign-up → log-in → accept chain never drops it. The plumbing is one tiny helper — `withInviteToken(base, token)` (`web/src/lib/invite-link.ts`) — that every page routes through, so the param name lives in exactly one place on the client (and it must match the `?inviteToken=` the backend puts in the email; a comment on each side pins the pair).

Because the return target is always the fixed `/invite` path — only the token varies — there's no arbitrary redirect URL to sanitize. The open-redirect hole that a general `?next=<any-url>` scheme would open simply never exists here.

One rough edge, noted honestly: if a brand-new Sam clicks the *verification* email instead of the signup screen's "back to log in" link, the backend's verify endpoint redirects to `/login?verified=1` and the token is dropped there. He isn't stuck — the invite is still in his inbox, and accepting never needed a verified email — but that one path doesn't glide straight back to accept. The signup screen's own login link *does* carry the token, so the intended route stays seamless.

---

## Step 5 — accepting: the token becomes a membership

Sam arrives back at the accept action **already authenticated** — through the login-or-signup hop just described. Now we know who he is. The route loads *his* email from his session — never from the request body — and hands it to `acceptTeamInvite`:

```ts
// src/teams/routes.ts — POST /invites/accept
const user = await loadUserOrThrow(userId)
const team = await acceptTeamInvite({ rawToken: input.token, userId, sessionEmail: user.email })
```

```ts
// src/teams/invites.ts — acceptTeamInvite
const invite = await findLiveInviteByToken(rawToken)          // same 400s as preview
if (invite === null) { throw badRequest('invalid_invite', ...) }
if (invite.email !== sessionEmail) {
  throw forbidden('invite_email_mismatch', 'This invite was sent to a different email address.')
}
await db.transaction(async (tx) => {
  await tx.insert(teamMembersTable)
    .values({ teamId: invite.teamId, userId, role: invite.role })
    .onConflictDoNothing({ target: [teamMembersTable.teamId, teamMembersTable.userId] })
  await tx.delete(teamInvitesTable).where(eq(teamInvitesTable.id, hashToken(rawToken)))
})
```

Three decisions are packed into those lines.

**The email match — and what it is and isn't for.** Recall the opening: the token is the capability. Whoever holds the link can, in principle, accept. So what does comparing `invite.email` to the logged-in user's email *add*?

It's a **correctness guard, not the security boundary.** The security boundary is the token itself — it was mailed to sam@example.com, so holding it already implies control of that inbox. The email match stops a *different* signed-in account (Theo, who somehow saw the link) from silently joining as himself. On a mismatch we return `403` and — crucially — **do not delete the invite**. The link isn't burned; Sam can still sign in as himself and accept the very same one. (This is also why we don't additionally require Sam's email to be *verified*: the token's arrival in his inbox is the proof, and re-proving it would just add friction. That's a deliberate call, written down so it doesn't read as a gap.)

**Seat, then burn, atomically.** The insert and the delete are one transaction, for the same reason team creation was in [doc 03](./03-creating-a-team.md): a crash between them must not leave Sam un-seated with the invite already spent, nor seated with the invite still live. Both, or neither.

**onConflictDoNothing makes accept idempotent.** What if Sam is *already* a member — a double-click, a race that slipped past the step-1 check, an invite issued the moment before he joined some other way? The `(team, user)` unique key from [doc 01](./01-the-teams-data-model.md) would reject a duplicate membership with an error. `onConflictDoNothing` turns that error into a no-op: if the membership exists, keep it (don't change the role), and still delete the invite. Accepting twice is harmless. Note the consequence we accept on purpose: an already-member who accepts a *different* role keeps their existing one — the invite doesn't downgrade or upgrade a seat that's already there.

The flow, end to end:

    Mara: Invite form on her dashboard team row → POST /teams/:id/invites { sam@…, member }
      ├─ requireTeamRole(admin+)         404 if not a member · 403 if a plain member
      ├─ owner-only to grant 'admin'     403 invite_admin_requires_owner
      ├─ already a member?               409 already_member
      └─ rotate token, store hash, email the RAW token to Sam
    ↓
    Sam clicks /invite?inviteToken=RAW
    ↓
    GET /teams/invites/preview?token=RAW   (public)  → { teamName, email, role }
    ↓
    Sam authenticates — token rides along in the URL   (InviteAcceptPage → login → back to /invite)
      • existing user → POST /auth/login                 (session created)
      • brand new     → POST /auth/signup (NO session!) → POST /auth/login
    ↓  app returns to /invite?inviteToken=RAW, now logged in
    POST /teams/invites/accept { token: RAW }
      ├─ unknown / used → 400 invalid_invite      (no oracle)
      ├─ expired        → 400 invite_expired       (row deleted)
      ├─ wrong email    → 403  (invite NOT consumed — Sam can still accept as himself)
      └─ match → seat membership + delete invite, in ONE transaction (idempotent)
    ↓
    Sam is a member of Design crew.

---

The five questions for this milestone:

**Where does this run?**

The decisions all run on the server: issuing and accepting are authed `/teams` routes, preview a public one, email the BullMQ worker. The browser only collects email + role (the dashboard form) and carries the token (the URL) — it hides what would fail, but enforces nothing.

**What shape is the data?**

In: an email + role (issue), or a raw token (accept). Out: a pending-invite summary, a public preview, or the team the caller just joined.

**What gets stored?**

On issue: one hashed-token row (replacing any prior one for that team+email). On accept: a `team_members` row, and the invite row deleted. Never the raw token.

**What's computed fresh?**

Every resolve hashes the presented token and looks it up live; expiry is checked against the clock at read time, and expired rows self-delete.

**What's handed on?**

A membership — the thing the rest of the app authorizes off ([doc 02](./02-team-authorization-404-not-403.md)). From here, Sam is indistinguishable from any other member.

---

The whole lifecycle in three beats:

    Issue rotates a token and emails the raw copy; only its hash is kept.
    Preview is public and shows only what the link's holder is entitled to see.
    Accept binds the token to its email as a correctness check, then seats-and-burns atomically — and idempotently.

Next: [doc 07](./07-a-public-route-in-a-private-plugin.md) — how exactly one `/teams` route escapes the auth hook that guards all the others, without punching a hole in it.
