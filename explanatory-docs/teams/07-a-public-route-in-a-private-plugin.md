# One public route in a private plugin — how the preview escapes the auth hook

> Increment: step 4 · M4 — team invites (public preview route + routing).
> Files: `src/teams/invite-public-routes.ts` (`teamInvitePublicRoutes`), `src/teams/routes.ts`,
> `src/server.ts`.

Every route under `/teams` requires a login. That's not enforced route-by-route — it's one hook on the whole plugin:

```ts
// src/teams/routes.ts
export const teamRoutes = async (app: FastifyInstance): Promise<void> => {
  app.addHook('onRequest', requireAuthHook)
  // ...every route below is auth-gated by construction
}
```

The comment from [doc 03](./03-creating-a-team.md) put it well: a new route added to this plugin *can't forget* to require auth, because auth isn't in the route — it's in the plugin, running before any handler.

Then [doc 06](./06-inviting-and-accepting.md) needed a route that is the exact opposite. Preview has to work for someone who is **not logged in** — Sam clicking a link before he has an account. A logged-out request to anything in `teamRoutes` is rejected with `401` at the hook, before the handler ever runs.

So how do you make *one* route public when the plugin's whole design is "everything here is private"? This doc is that one question.

---

## The tempting wrong answer: an exception inside the handler

The obvious move is to keep preview in `teamRoutes` and somehow skip the hook for it. But `onRequest` runs for every route in the plugin — there's no clean "except this one" flag. You'd end up either:

- making the *whole plugin* public and re-adding auth to each other route by hand (throwing away the "can't forget" property that made the hook worth having), or
- letting the hook run, then inside it detecting "oh, this is the preview path" and returning early — a special case, in the one place that must never have special cases, keyed off a path string that a typo would silently break.

Both corrode the thing that made the plugin safe. The hook's value is that it's *unconditional*. Add one condition and you've started down the road where the next condition is easier to add, and eventually one of them is wrong and a route is quietly unprotected.

## The right answer: a second plugin, at the same prefix

Fastify **encapsulates hooks per plugin.** A hook registered inside one plugin instance applies to the routes of *that* instance and its children — it does not leak to a sibling plugin, even one mounted at the same URL prefix. ([Doc 03](./03-creating-a-team.md) noted this in passing; here it's the whole mechanism.)

So the public route lives in its own tiny plugin that simply never adds the hook:

```ts
// src/teams/invite-public-routes.ts
export const teamInvitePublicRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/invites/preview', async (req) => {
    const { token } = parseOrThrow(previewQuery, req.query)
    const invite = await previewTeamInvite(token)
    return { invite }
  })
}
```

And both plugins are mounted at the same `/teams` prefix in the server:

```ts
// src/server.ts
app.register(teamRoutes, { prefix: '/teams' })              // has the auth hook
app.register(teamInvitePublicRoutes, { prefix: '/teams' })  // does NOT
```

`GET /teams/invites/preview` is served by the second plugin, which has no `onRequest` auth hook, so a logged-out request sails through to the handler. Every *other* `/teams/...` route is served by the first plugin and still hits the hook. Two plugins, one prefix, different hook scopes. The private plugin stays unconditionally private; the public route is public because it lives somewhere the hook was never added — not because a condition let it through.

This is why preview is the *only* thing in the public plugin, and why it's a read. Everything that mutates — issue, revoke, accept — stays in `teamRoutes` behind auth. The public surface is exactly one route, and even it only returns what the token's holder is already entitled to see ([doc 06](./06-inviting-and-accepting.md)).

---

## The routing trap this walks straight into

Put the routes side by side and something should look dangerous:

    GET  /teams/:teamId            ← teamRoutes (private):  "fetch team by id"
    GET  /teams/invites/preview    ← public plugin:          "preview an invite"

    POST /teams/:teamId/invites    ← teamRoutes (private):  "invite to team :teamId"
    POST /teams/invites/accept     ← teamRoutes (private):  "accept an invite"

`/teams/:teamId` is a **parametric** route: `:teamId` matches *any* single segment. So what happens when a request for `/teams/invites/accept` arrives — does `invites` get captured as a `:teamId` value, routing it to the wrong handler (or, worse, into the public plugin's space)?

It doesn't, and the reason is a rule worth knowing: **Fastify's router (find-my-way) always prefers a static segment over a parametric one at the same position.** Given both a literal `invites` child and a `:teamId` child at the node after `/teams`, a request whose next segment is literally `invites` takes the static branch every time. Only a segment that matches *no* static child falls through to `:teamId`.

Trace the three cases:

    /teams/3c1c…-uuid          → no static 'invites' match → :teamId = "3c1c…"     ✓ private
    /teams/invites/accept      → static 'invites' → static 'accept'                ✓ private
    /teams/invites/preview     → static 'invites' → static 'preview'               ✓ public

No collision, and Fastify doesn't error at registration either — a static route and a parametric route can coexist at the same position; what it *rejects* is two routes with the identical method and path. `/:teamId` and `/invites/preview` are not identical, so both register cleanly. (A quick `buildServer().ready()` confirms it — the server boots with all routes mounted.)

There's a real hazard hiding behind this, though, and it's on the **frontend**, not here: the Vite dev proxy forwards `/teams` to the API. If the app also had a *page* route literally called `/teams/:id`, it could shadow the proxied API path. That's why the app's team page is `/team/:teamId` (singular) — deliberately not a prefix of the proxied `/teams`. That's an M7 concern, flagged in the teams plan; noted here so the two "teams vs team" decisions don't get confused. On the *server*, the static-over-parametric rule is all you need.

---

The five questions for this milestone:

**Where does this run?**

The server's routing layer. Two Fastify plugins at one prefix; the router picks handlers.

**What shape is the data?**

Unchanged from [doc 06](./06-inviting-and-accepting.md) — this doc is about *which handler runs*, not what it returns.

**What gets stored?**

Nothing new. Preview is a pure read.

**What's computed fresh?**

The route match, per request: static-over-parametric decides public vs private before any handler or hook runs.

**What's handed on?**

A public entry point for an unauthenticated invitee, carved out without weakening the auth hook that guards every other `/teams` route.

---

The whole idea in three beats:

    Hooks are per-plugin, so a sibling plugin at the same prefix simply doesn't inherit the auth hook.
    That keeps the private plugin unconditionally private — no per-route exceptions to get wrong.
    Static routes beat parametric ones, so /invites/preview and /invites/accept never get captured as a :teamId.

This closes the invites backend milestone (M4). The clickable invite flow that sits on top of it — the `/invite` landing page and accept-through-login (M8) — is built too; [doc 06](./06-inviting-and-accepting.md) traces it as step 4 of the flow.
