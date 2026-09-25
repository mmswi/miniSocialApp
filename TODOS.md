# TODOS

## Block account deletion while the user is a team superadmin

- **What:** when account deletion is built, refuse it (409) while the user is the superadmin of any team.
- **Why:** `team_members.user_id` cascades on user delete (`src/db/schema.ts`), so deleting a superadmin's
  account silently leaves a team with no superadmin — nobody could manage, transfer or delete it.
- **Pros:** keeps the "exactly one superadmin per team" invariant true without extra machinery.
- **Cons:** the user must transfer each team first; the UI has to list which teams block the deletion.
- **Context:** decided in the teams v2 eng review (2026-09-25, decision 2A). The partial unique index only
  guarantees *at most* one superadmin; nothing in the database guarantees *at least* one. Plan:
  `~/.gstack/projects/miniSocialApp/mihaimarinescu-feature-teams-plan-v2-20260925.md`.
- **Depends on / blocked by:** an account-deletion feature (none exists yet); teams v2 V1 (superadmin role).
