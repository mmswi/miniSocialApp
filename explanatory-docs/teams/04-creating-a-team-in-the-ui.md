# Creating a team in the UI

> Increment: step 4 · a first slice of M7 — the create-a-team affordance on the dashboard.
> Files: `web/src/lib/api.ts`, `web/src/components/SelectField.tsx`,
> `web/src/pages/DashboardPage.tsx`, `web/vite.config.ts`.

The backend can create teams. The browser couldn't ask it to.

This increment closes that one gap: a **Teams** card on the dashboard that lists the teams you're in and lets you make a new one. Not the full sidebar app shell the plan eventually wants — a first, working slice of it.

Follow one click. Mara opens the dashboard, presses **New team**, names it *Design crew*, and it appears in her list.

Four decisions along that path are worth pulling out, because each had a wrong version I had to *not* write.

---

## The client keeps its own copy of the team enums

The form needs the three access levels — `read`, `write`, `delete` — and the list shows a role. Those already exist on the server, in `db/schema.ts`. So import them, right?

```ts
// ✗ drags the entire Postgres schema into the browser bundle
import { TEAM_ACCESS_LEVELS } from '../../../src/db/schema'
```

That one import pulls `db/schema.ts`, which pulls `drizzle-orm`, into the *client* bundle. The browser has no business shipping the database layer.

So the client keeps its **own** mirror, marked as a mirror:

```ts
// web/src/lib/api.ts
export const CLIENT_TEAM_ACCESS_LEVELS = { read: 'read', write: 'write', delete: 'delete' } as const
export type ClientTeamAccessLevel =
  (typeof CLIENT_TEAM_ACCESS_LEVELS)[keyof typeof CLIENT_TEAM_ACCESS_LEVELS]
```

The `CLIENT_` prefix is a promise to the reader: *this is a deliberate copy of one wire contract, not a shared source — don't assume it auto-syncs with the server's.* The two are kept in step by hand, because the alternative is shipping Drizzle to every visitor.

The types get distinct names too — the client's team is `TeamMeta`, the server's is `TeamSummary`. Same reason as `DocumentMeta` before it: if both sides called it `TeamSummary`, an editor's auto-import in a `web/` file could resolve to the *server's* type and quietly drag the schema across the boundary. A different name makes the wrong import impossible.

---

## The form is an inline expand, not a modal

Pressing **New team** doesn't pop a dialog. It expands a small form in place, right under the button — the same move the Security page uses for "add a passkey" and "disable 2FA." Press **Cancel** and it collapses; collapsing also *resets* it, so reopening starts clean.

That's a house-style choice, not an accident: no modal, no dropdown, no overlay to trap focus and dim the page. The form lives in the flow of the card. One fewer component, one fewer thing to make accessible, and the page never jumps.

---

## The `<select>` value is narrowed back to the enum at the boundary

A native `<select>` hands you back a **string**. But the team's access level is `ClientTeamAccessLevel` — one of exactly three values. If you let the string straight into state, you've quietly lost the type:

```ts
// ✗ the state decays to a bare string; a typo elsewhere no longer fails to compile
onChange={(event) => setTeamAccessLevel(event.target.value)}
```

So there's a tiny narrowing function at the seam. It looks the value up against the options the form actually renders, and falls back to the safest ceiling if it's ever something unexpected:

```ts
const toTeamAccessLevel = (value: string): ClientTeamAccessLevel =>
  teamAccessLevelOptions.find((option) => option.value === value)?.value ??
  CLIENT_TEAM_ACCESS_LEVELS.read
```

The raw string is untrusted input — even from your own `<select>` — so it gets checked at the door, not cast through it. That's also why `SelectField` is a new shared primitive rather than a raw `<select>`: it's the `TextField` twin, same label and styling, so a form mixes the two with no visual drift.

---

## The dev proxy, and the one bug the tests can't see

In development the React app runs on Vite at `:3000` and the API runs at `:3001`. For the browser to send its session cookie same-origin, Vite *proxies* API paths through to `:3001`. Teams needed a new line:

```ts
// web/vite.config.ts
'/teams': 'http://localhost:3001',
```

Miss that line and every call to `/teams` is caught by Vite's SPA fallback — the browser gets the app's HTML back instead of JSON, and team creation 404s in a confusing way.

Here's the trap: **the unit tests can't catch it.** They stub `fetch`, so they never touch the proxy — a typo'd proxy line passes every test and only breaks in a real browser. So this slice was verified the one way that actually exercises the proxy: both servers up, driving `signup → login → create → list` *through* `:3000`, and confirming the response comes back as `application/json` (proxied to the API), not `text/html` (Vite's fallback).

One related note for later: when a single-team page arrives, its app route must be `/team/:id` — **singular** — so it never prefix-matches this proxied `/teams` path and get forwarded to the API by mistake.

---

## Why the list refetches after a create

There's no team page to navigate to yet. So after `API_createTeam` succeeds, the card collapses the form and **refetches** the list:

```ts
await API_createTeam({ name: trimmedName, accessLevel: teamAccessLevel })
closeTeamForm()
await loadTeams()
```

Why not just push the created team into local state? Because the create response is a plain `TeamMeta` — it doesn't carry your *role*. The server seats you as `owner` (that's the transaction from [doc 03](./03-creating-a-team.md)), and the list endpoint is what joins that role in. Refetching means the new row shows up exactly as the server sees it — *Design crew · owner* — with no guessing on the client.

The five questions for this slice:

**Where does this run?**

The browser — a React card on the dashboard. Every API call is proxied same-origin to the server at `:3001`.

**What shape is the data?**

Out: a team name + an access level. Back: a `TeamMeta`, and on the list each team plus the caller's role.

**What gets stored?**

Nothing new on the client — the server persists the team and the owner membership. The client holds only the current list in component state.

**What's computed fresh?**

The team list, refetched on mount and again after each create — never cached.

**What's handed on?**

A working create-and-see affordance, and the `API_*` client + `SelectField` primitive that the sidebar shell and TeamPage (the rest of M7–M9) will build on.

---

## What this slice isn't

The plan's M7 is a whole app shell — a left sidebar with "My space" and the teams, a dedicated `/team/:id` page with members and settings. This is not that. It's the smallest thing that answers "I can't create a team in the UI": a card, a form, a list.

The pieces built here — the client API functions, the `SelectField`, the create-and-refetch logic — all carry straight over when the sidebar lands. The card's JSX just moves.

The whole thing in three beats:

    The client mirrors the team enums so the browser never ships the database.
    The form expands in place, narrows its select back to a real type, and refetches to learn its role.
    The proxy is the one seam the tests can't see — so it's the one seam you drive live.
