# How the invited teammate actually finds the shared document

> Increment: step 4 · M9-1 — app shell, sidebar, and the team page.
> Files: `web/src/components/AppShell.tsx`, `web/src/pages/TeamPage.tsx`,
> `web/src/pages/DashboardPage.tsx`, `web/src/App.tsx`, `src/teams/{routes,teams}.ts`
> (`GET /teams/:teamId/members`).

The backend can now share a document with a team ([M5](./10-effective-access-max-level-in-ts.md)) and enforce who may edit it ([M6](./12-read-only-over-the-wire.md)). But stand in the invited teammate's shoes and there's a hole: **they have no way to find the document.**

Walk it through with the running example:

    Ana owns "Q3 Launch Plan" and shares it into the Design team.
    Ben is in Design. He should be able to open and edit it.

Before this milestone, Ben's dashboard listed only the documents Ben *owns*. "Q3 Launch Plan" isn't his. It never appeared anywhere he could click. The only way in was typing `/editor/<uuid>` by hand — which is not a feature, it's a workaround. This milestone gives Ben a path he can click: **sidebar → the team → its documents → the editor.**

---

## The bad version: teams and documents crammed onto one page

Before, everything lived on the dashboard — your documents, your teams, the invite forms, all stacked in one column. Add "each team's shared documents" and "each team's members" to that and the page collapses under itself. There's no room to grow, and no stable place that means "this team."

The fix is a real navigation structure, and it's three routes:

    /              → My space   (the documents you own + your account)
    /team/:teamId  → Team page  (that team's documents + members + invites)
    /editor/:id    → Editor     (one document, full-screen)

And one thing wrapping the first two: a persistent sidebar.

## The shell: one sidebar, always there

`AppShell` is a layout — a left sidebar plus a main column for whatever page you're on:

    ┌──────────────┬─────────────────────────────┐
    │  My space    │                             │
    │              │      (page content)         │
    │  TEAMS   +   │                             │
    │  Design      │   dashboard, or a team page │
    │  Legal       │                             │
    └──────────────┴─────────────────────────────┘

The dashboard renders inside it. The team page renders inside it. The **editor does not** — it keeps its focused, full-width layout, because when you're editing you don't want a nav rail stealing attention.

The sidebar owns one thing: the list of teams you belong to, fetched once from `GET /teams`, each rendered as a link to `/team/:teamId`. It's also where you create a team now (the little `+`), because "make a new team" belongs next to "here are your teams," not buried on the dashboard. Creating one drops you straight onto its page:

```tsx
// web/src/components/AppShell.tsx — after a successful create
const { team } = await API_createTeam({ name, accessLevel })
await loadTeams()          // the sidebar now shows it
navigate(`/team/${team.id}`)   // ...and you land on it, ready to add docs + invite people
```

There's a naming trap the route deliberately sidesteps. The API is served under `/teams` (plural), and the Vite dev server proxies that path to the backend. If the *app* page were also `/teams/:id`, a full-page load would get proxied to the API and return raw JSON. So the app page is `/team/:teamId` — **singular** — which is not a prefix of `/teams`, so it's never proxied. ([Doc 07](./07-a-public-route-in-a-private-plugin.md) flagged this exact trap from the server side; here's where the client honors it.)

## The team page: where Ben finds the document

`/team/:teamId` is the payoff. When Ben opens `/team/design`, the page makes three reads, in order:

    GET /teams/design            → the team + Ben's role in it        (proves he's a member)
    GET /teams/design/documents  → the documents shared into Design   ← "Q3 Launch Plan" is here
    GET /teams/design/members    → who's on the team

The first read is the gate. If Ben *weren't* a Design member, `GET /teams/design` returns `404` (the [no-oracle](./02-team-authorization-404-not-403.md) rule — a non-member can't tell the team apart from one that doesn't exist), and the page shows a "doesn't exist, or you're not a member" state instead of the team. Because that read establishes membership, the two that follow — documents and members, both `member+` reads — are safe to fire together:

```tsx
// web/src/pages/TeamPage.tsx
const { team, role } = await API_getTeam(id)          // 404 here → notFound state, no further reads
const [{ documents }, { members }] = await Promise.all([
  API_listTeamDocuments(id),
  API_listTeamMembers(id),
])
```

And there it is: "Q3 Launch Plan" in the Documents list, each row a link to `/editor/<id>`. Ben clicks it and he's in the editor — the same editor Ana is in, co-editing live ([M5](./11-rest-ws-parity-the-resolver-gates-the-room.md)), read-only if Design is a read team ([M6](./12-read-only-over-the-wire.md)). The click path is closed.

`GET /teams/:teamId/members` is the one new backend endpoint this milestone needed — a small `member+` read returning each member's name, email, and role, so the team page can show its roster. Everything else Ben needs already existed from M5.

## What moved, and why the dashboard got smaller

Introducing the sidebar meant **relocating** things, not just adding:

- The **teams list** and **create-team** form moved from the dashboard into the sidebar. Teams are navigation now; they belong in the nav.
- The **invite form** moved from the dashboard onto the team page. You invite someone *to a team*, so the control lives *on that team's page*, gated to admins-and-up exactly as before ([M8](./06-inviting-and-accepting.md)) — a plain member never sees it.

So the dashboard shrank to what "My space" actually is: the documents you own, and your account. One consequence worth noting for the next milestone: because the dashboard lists only *owned* documents, the Share control that [M9-2](./14-the-sharing-ui.md) adds there is implicitly owner-only — you can only reach the Share button on a document that's yours.

---

The five questions for this milestone:

**Where does this run?**

The browser. Three React routes and a shared layout component; the only new server code is one `member+` read endpoint.

**What shape is the data?**

The sidebar holds a list of `{ id, name, role }` teams. The team page holds a team, the caller's role, a list of shared documents (each with its owner's name), and a list of members.

**What gets stored?**

Nothing new on the server. This milestone is navigation — it *reads* the shares and memberships earlier milestones wrote.

**What's computed fresh?**

Every list is fetched live per page visit. The active-team highlight in the sidebar is derived from the current URL.

**What's handed on?**

A clickable path from "I was invited to a team" to "I'm editing its document." The next milestone ([M9-2](./14-the-sharing-ui.md)) closes the loop from the other end: how Ana puts the document into the team in the first place, from the UI instead of a hand-issued API call.

---

The whole idea in three beats:

    A shared document was unreachable — the dashboard listed only what you OWN, so an invitee had no link to click.
    A persistent sidebar lists your teams; each team's page lists its documents; each document links to the editor.
    Membership is proven by the first read (404 for a non-member, no oracle), so the document and member reads that follow are safe.

Next: [doc 14](./14-the-sharing-ui.md) — the Share panel that puts Ana's document into the Design team without a single API call by hand.
