# The read-only editor — matching the server's "no" in the UI

> Increment: step 4 · M9-3 — the read-only editor.
> Files: `web/src/pages/DocumentEditorPage.tsx`, `web/src/editor/CollaborativeEditor.tsx`,
> `web/src/lib/api.ts` (`access` on `API_getDocument`, `canEditWithAccess`).

[M6](./12-read-only-over-the-wire.md) made the server drop a read-level member's edits over the websocket. That's the real enforcement — but on its own it produces a bad experience. Picture Cass:

    Cass is in Legal (read).
    "Q3 Launch Plan" is shared into Legal.
    Cass opens it and starts typing.

Her editor accepts the keystrokes. Text appears. Then it... doesn't sync. The server silently drops each update, so nobody else sees it, and on reload it's gone. From Cass's chair, she typed a paragraph and it vanished. The server said "no" correctly, but never told *her*.

This milestone makes the UI say the same "no" the server already enforces — before she wastes a keystroke.

---

## First, the client has to KNOW the access

The editor page already fetched the document's title over REST. Since [M5](./10-effective-access-max-level-in-ts.md), that same response carries one more field:

```ts
// GET /documents/:id  →
{ document: { id, title, ... }, access: 'owner' | 'read' | 'write' | 'delete' }
```

So the page reads `access` alongside the title, and turns it into a single boolean with the *same rule the server uses*:

```ts
// web/src/lib/api.ts — mirrors the server's canWriteDocument
export const canEditWithAccess = (access: ClientDocumentAccess): boolean =>
  access === CLIENT_DOCUMENT_ACCESS_OWNER ||
  access === CLIENT_TEAM_ACCESS_LEVELS.write ||
  access === CLIENT_TEAM_ACCESS_LEVELS.delete
```

Owner, write, delete → editable. Read → not. This is deliberately the twin of the server's `canWriteDocument` ([doc 10](./10-effective-access-max-level-in-ts.md)): the client goes read-only in *exactly* the cases the server would drop the write. If the two rules disagreed, you'd get the confusing states — an editable UI the server rejects, or a locked UI the server would have allowed.

## Then, gate the editor on knowing it

There's a timing trap. The editor's Yjs doc and sync provider are created immediately on mount; the access arrives a moment later, when the REST fetch resolves. If the editor mounted *editable* and then flipped to read-only when `access` came back, Cass would get a brief editable flash — and maybe a keystroke in that window.

So the page holds the editor on "Loading editor…" until `access` is known, then mounts it once, already correct:

```tsx
// web/src/pages/DocumentEditorPage.tsx
const canEdit = access !== null && canEditWithAccess(access)

{session && access !== null ? (
  <CollaborativeEditor /* ... */ editable={canEdit} />
) : (
  <p>Loading editor…</p>
)}
```

The editor never exists in the wrong mode. It waits until it can be built right.

## What `editable={false}` actually does

The prop flows into TipTap's `useEditor({ editable })`. When `false`, TipTap makes the surface non-editable — `contentEditable` is off, so keystrokes never turn into Yjs updates in the first place:

```tsx
// web/src/editor/CollaborativeEditor.tsx
const editor = useEditor({
  editable,
  extensions: [ ...documentExtensions, Collaboration.configure({ document: doc }), CollaborationCaret.configure(...) ],
  editorProps: { attributes: { 'aria-label': editable ? 'Document editor' : 'Document, view only' } },
})
```

Cass can select text, scroll, and watch Ana's edits stream in live — but she can't type. Her keystrokes don't get swallowed downstream; they never start.

One thing stays on even for a reader: **her cursor**. Awareness rides a separate channel the server never blocks ([M6](./12-read-only-over-the-wire.md)), so Cass's presence still shows to everyone. A viewer is present, just not editing.

## The two smaller cues

Beyond locking the surface, two UI touches make the state legible:

- **A "View only" chip** in the header, shown when `isViewOnly`. It names the state so Cass isn't left guessing why she can't type.
- **A static title instead of the editable one.** Renaming needs write+ (the server 403s a reader's `PATCH`), so a reader gets a plain `<span>{title}</span>`, not the interactive `DocumentTitle`. The UI doesn't offer an affordance the server would reject — the same principle as [hiding the invite control from a plain member](./13-the-app-shell-and-navigating-to-a-shared-doc.md).

## The line that matters: this is convenience, not security

It would be a mistake to read this milestone as "now read-only is enforced." It was *already* enforced, at the server ([M6](./12-read-only-over-the-wire.md)). `editable={false}` is a courtesy to the honest user — it stops Cass wasting effort and tells her why.

A dishonest client can flip `editable` in devtools, or skip the editor entirely and send a raw update over the socket. That's fine: the server drops it exactly as before. The UI's job here is not to *stop* the write — the server does that — it's to not *invite* one it will silently refuse. Two layers, two jobs: the server guarantees correctness; the client provides clarity.

---

The five questions for this milestone:

**Where does this run?**

The browser. The page reads `access` from the REST metadata and passes an `editable` flag into the TipTap editor. The actual enforcement runs on the server (M6).

**What shape is the data?**

One extra field on the document-metadata response — `access` — collapsed to a single `editable` boolean via the same rule the server uses.

**What gets stored?**

Nothing new. Access is read per document open; a reader's (blocked) keystrokes were never going to be stored, which is the whole point.

**What's computed fresh?**

`canEdit` is derived from `access` on each open. The editor is mounted once, after access is known, so it never changes mode mid-life.

**What's handed on?**

A UI that agrees with the server: read access is view-only on screen, not just on the wire. With this, the teams feature is clickable and coherent end to end.

---

The whole idea in three beats:

    The server already refuses a reader's edits, but silently — so a reader types into a void; the UI must say "no" first.
    The metadata response carries `access`; the page waits for it, then mounts the editor `editable` by the SAME rule the server enforces.
    editable={false} plus a "View only" chip and a static title is clarity for the honest user — the server stays the real guard.

This closes the teams feature (step 4). A document can be owned, shared into teams, reached by a teammate, co-edited live, and — for a read-only member — viewed without a single misleading affordance. Sharing, access, realtime, and the UI all speak with one voice.
