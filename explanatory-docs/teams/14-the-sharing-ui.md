# Putting a document into a team — the Share panel

> Increment: step 4 · M9-2 — the sharing UI.
> Files: `web/src/pages/DashboardPage.tsx` (the Share panel),
> `web/src/lib/api.ts` (`API_getDocumentTeams`, `API_assignDocumentToTeam`, `API_unassignDocumentFromTeam`).

[Doc 13](./13-the-app-shell-and-navigating-to-a-shared-doc.md) gave Ben — the invited teammate — a way to *reach* a shared document. But it skipped the step before that: how does the document get shared in the first place?

Until now, it didn't, from the UI. The backend could do it ([M5](./09-additive-sharing-assign-a-document.md)), but the only way to trigger it was a hand-issued API call in the browser console. That's the exact "no UI, no feature" gap this milestone closes.

The example, from Ana's side:

    Ana owns "Q3 Launch Plan".
    She's in the Design team and the Legal team.
    She wants it in Design (to edit) but NOT Legal.

She needs a control that says, per document: which of my teams is this in? Check the ones you want.

---

## The shape of the control: a checkbox per team

Sharing is not a one-time action — it's a *state* you toggle. "Q3 Launch Plan" is either in Design or it isn't, and Ana might change her mind. So the control isn't a "Share" button that fires once; it's a set of checkboxes, one per team, each reflecting "is this document in that team right now."

The bad version is a modal with a team dropdown and an "Add" button, building up a list. That models sharing as *appending*, when it's really *toggling membership in a set*. A checkbox list says exactly what's true — these teams have it, those don't — and one click flips one fact.

So each owned document row on the dashboard gets a **Share** link that expands an inline panel (house style: no modal, one open at a time — the same inline-expand pattern as the invite form). Opening it for "Q3 Launch Plan" shows:

    Share with your teams
      ☑ Design · write access
      ☐ Legal · read access

Design is checked because the document is already shared there; Legal isn't.

## Opening the panel: two reads, joined into checkbox state

To draw those checkboxes correctly, the panel needs two things at once:

    which teams is Ana in?          → API_listTeams()            (the rows to show)
    which of them has this document? → API_getDocumentTeams(id)   (the ones to check)

```tsx
// web/src/pages/DashboardPage.tsx — openShare
const [{ teams }, { teams: shares }] = await Promise.all([
  API_listTeams(),
  API_getDocumentTeams(documentId),
])
setShareTeams(teams ?? [])
setSharedTeamIds(new Set(shares.map((share) => share.id)))   // a Set for O(1) "is this one checked?"
```

The teams become the checkbox rows. The shares become a `Set` of team ids, and a box is checked when its team id is in the set. Storing the shares as a `Set` (not an array) is deliberate: rendering asks "is team X shared?" once per row, and `set.has(x)` answers in constant time.

`API_getDocumentTeams` is the owner-only `GET /documents/:id/teams` from [M5/M9-1](./10-effective-access-max-level-in-ts.md). Owner-only is safe *by construction* here: the dashboard lists only documents Ana owns, so the Share control is only ever reachable for a document that's hers. The UI never even offers a Share button on someone else's document — there are none on this page.

## Toggling a box: assign or unassign, then reflect it

A click on a box does one of two calls, decided by whether it was already checked:

```tsx
// web/src/pages/DashboardPage.tsx — onToggleShare
if (isCurrentlyShared) {
  await API_unassignDocumentFromTeam(teamId, documentId)   // DELETE /teams/:teamId/documents/:documentId
  setSharedTeamIds((current) => { const next = new Set(current); next.delete(teamId); return next })
} else {
  await API_assignDocumentToTeam(teamId, documentId)        // POST /teams/:teamId/documents { documentId }
  setSharedTeamIds((current) => new Set(current).add(teamId))
}
```

Check Legal → `POST` shares "Q3 Launch Plan" into Legal, and the id joins the set so the box shows checked. Uncheck Design → `DELETE` unshares it, and the id leaves the set. The box always mirrors the set, and the set mirrors what we just told the server.

Notice we update `sharedTeamIds` from the *local* result of the call, not by re-fetching. Assign and unassign are small, reversible actions with an unambiguous outcome — the checkbox flips the instant the call resolves, no round-trip to re-read the whole share list. During the in-flight call the box is disabled (`togglingTeamId`), so a double-click can't fire the opposite call before the first lands.

And every write here is one Ana is allowed to make: she owns the document, so `POST` (member-of-the-team + owns-the-doc) and `DELETE` (owner may always unassign) both succeed — the [M5 authorization](./09-additive-sharing-assign-a-document.md) and the UI agree, because the UI only exposes actions the owner can take.

## The loop is now closed

Put this milestone next to the last two and the whole feature is clickable end to end:

    Ana checks "Design" in the Share panel        (M9-2, here)   → the document is in Design
    Ben opens Design's page in the sidebar          (M9-1)        → he sees "Q3 Launch Plan"
    Ben clicks it → the editor                       (M9-1)        → he's co-editing live (M5), read-only if Design is read (M6)

No console, no hand-typed URL, no API call by hand. The one thing still missing is what Ben *sees* when Design is a read-only team — the editor still lets him try to type (the server drops it, but that's a confusing experience). That's the last milestone.

---

The five questions for this milestone:

**Where does this run?**

The browser, in the dashboard's Share panel. It calls three existing server endpoints; no new server code.

**What shape is the data?**

A list of the caller's teams (checkbox rows) and a `Set` of team ids the document is shared into (which boxes are checked).

**What gets stored?**

On each toggle, one `document_teams` row is inserted or deleted server-side ([the join table from doc 08](./08-the-document-teams-join-table.md)). Locally, only the `Set` of checked team ids.

**What's computed fresh?**

The panel's two reads run each time it's opened. Checkbox state is derived from the `Set`; a toggle updates the `Set` from the call's result rather than re-reading.

**What's handed on?**

A document actually placed into a team, from the UI — the input the team page ([doc 13](./13-the-app-shell-and-navigating-to-a-shared-doc.md)) reads to show it to the team's members.

---

The whole idea in three beats:

    Sharing is a toggled state, not a one-shot action, so the control is a checkbox per team, not an "Add" button.
    Opening the panel joins two reads — your teams and this document's shares — into "which boxes are checked."
    A click assigns or unassigns and flips the box locally; owner-only is implicit because the dashboard only lists documents you own.

Next: [doc 15](./15-the-read-only-editor.md) — the last piece: an editor that shows "View only" and refuses to let a read-level member type, so the client matches the server's read-only enforcement instead of silently swallowing their keystrokes.
