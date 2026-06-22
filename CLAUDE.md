# miniSocialApp — CLAUDE.md

> **Working name only.** This repo is a real-time **collaborative document review tool**, not a
> social app. Rename before publishing (e.g. `redline`, `marginalia`).

## What this is
A portfolio + learning project: a real-time collaborative document review tool. Import a PDF →
editable markdown → invite a team → request review → reviewers leave comments anchored to passages
that survive concurrent edits → real-time notifications → versioned republish. Built to learn 9
skill areas at production-grade depth, including real-time collaborative editing (CRDTs).

Audience = senior engineers reading the GitHub repo + a blog post + a live demo. Optimize for
credible production skill and the learning actually happening, not user growth.

## Source of truth (read this first)
The full design and every review decision live in the design doc:

`~/.gstack/projects/miniSocialApp/mihaimarinescu-no-branch-design-20260622-172535.md`

It has been through office-hours, a CEO/strategy review, and an eng review (auth slice). It ends
with a `## GSTACK REVIEW REPORT`. Treat it as authoritative; this CLAUDE.md is a pointer + quick ref.

Build task lists (checkbox as you ship) and the auth test plan live alongside it:
- `tasks-eng-review-20260622-182153.jsonl` — auth slice, 10 tasks (A1–A10)
- `tasks-ceo-review-20260622-180444.jsonl` — whole project, 12 tasks
- `mihaimarinescu-no-branch-eng-review-test-plan-20260622-181500.md` — auth test plan (for /qa)

## Stack & tooling
- Runtime + package manager: **bun** (never npm/pnpm)
- Lint + format: **biome** (never eslint/prettier) — keep a `biome.json` from commit one
- Language: TypeScript, strict, no `any`
- Backend: Fastify + Postgres (Drizzle ORM) + Redis (queue + pub/sub + cache + session cache)
- Realtime/editor (step 2+): React + Vite + TipTap + Yjs + y-protocols (hand-built sync layer)
- Deploy (later): long-lived container host (Railway/Render/Fly) — persistent ws + worker, NOT serverless

## Conventions
- **Before writing or refactoring any TypeScript/React code, invoke the `mihai-coding-standards`
  skill** (global) and follow it. It is the authority for naming, imports, props, conditionals,
  and structure in this repo. Do not hand-write TS/React from memory — load the skill first.
- Quick summary (the skill is canonical): **named exports** (no default), **intentful names**,
  **no `any`** (everything typed), no barrel files, arrow functions, tree-shakeable imports.
- **Server singletons are correct, not a smell.** Shared infrastructure (DB pool, Redis, worker,
  event bus) is a single instance per process, cached on `globalThis as unknown as XGlobal` so dev
  hot-reload reuses it; keep the import side-effect-free with a lazy connection (e.g. ioredis
  `lazyConnect`, postgres-js's lazy pool). The standards' "no module-level side effects" rule is a
  **frontend/bundler** concern and does NOT forbid server singletons. See `src/lib/redis.ts`,
  `src/db/client.ts`. Use a factory (`createX()`) only for things you make many of or inject in tests.
- ASCII diagrams in comments for non-obvious flows (state machines, pipelines); keep them current.
- Depth tiering: production-grade on the 3 headline skills (CRDT sync, ws auth/reconnect, Redis
  cross-instance fan-out); **solid + failure-mode-aware** on the rest.

## Testing
- Runner: `bun test`. Write tests **alongside** the code, never as a follow-up.
- Auth flows are E2E-critical — don't trust unit tests alone. Follow the auth test plan above
  (4 E2E flows + 6 security cases).

## Current status & build order
Building **auth first (step 1)** — the thing the user wants to learn first.

**Auth slice decisions (eng review D2/D3/D4):**
- **Hand-roll** the auth core (sessions, linking) on vetted primitives: `argon2id` (hashing) +
  `arctic` (Google OAuth2/OIDC + PKCE + state). Do not roll your own crypto.
- **Postgres-backed sessions** (opaque httpOnly cookie token) with a **Redis read-through cache**
  on the session→user lookup; logout deletes the row + busts the cache.
- **Minimal email verification in step 1** → enables safe verified-email auto-linking.
- Data model: `users` (identity) 1─< `accounts` (password + google identities) + `sessions`.
- Security must-haves: no user-enumeration, OAuth state + PKCE, session-id rotation on login,
  rate-limited auth endpoints.

**Then:** 2) editor + hand-built Yjs multiplayer (go/no-go gate vs Hocuspocus at end of step 2) ·
3) PDF import pipeline · 4) teams + invites · 5) anchored comments **← minimum shippable
checkpoint** · 6) notifications · 7) versioning + caching · 8) hardening · 9) scale-out + deploy ·
10) blog post.

## Skill routing
When a request matches a gstack skill, invoke it. Key routes:
- **Writing/refactoring/reviewing TS or React → invoke `mihai-coding-standards` first**
- Strategy/scope → /plan-ceo-review · Architecture → /plan-eng-review · Design → /plan-design-review
- Bugs/errors → /investigate · QA → /qa · Code/diff review → /review · Ship/PR → /ship
- Save progress → /context-save · Resume → /context-restore
