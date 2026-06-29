import { StarterKit } from '@tiptap/starter-kit'

// The document's content schema, as a STANDALONE TipTap extension set — deliberately no Collaboration,
// no React, no browser globals. Two reasons it lives apart from the editor component:
//
//   1. It defines the ProseMirror schema (which nodes/marks a document may contain). The Yjs↔ProseMirror
//      binding desyncs if the two ends disagree, so the schema must come from ONE place.
//   2. Step 3's PDF-import worker seeds a Y.Doc server-side and must produce a structure conformant to
//      this exact schema (via `getSchema(documentExtensions)`). When it lands, it SHARES this module —
//      it must not copy it, or the two schemas drift and the binding breaks.
//
// undoRedo is OFF: Yjs owns undo/redo for collaborative docs (a shared history, not a per-tab one), so
// StarterKit's local history extension would fight it. The restricted allowlist (no raw-HTML node) is
// the seed of the step-8 sanitization hardening; StarterKit's default node/mark set is already a safe,
// closed list — no arbitrary HTML passes through.
export const documentExtensions = [StarterKit.configure({ undoRedo: false })]
