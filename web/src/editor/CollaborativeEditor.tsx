import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Doc } from 'yjs'
import { documentExtensions } from './document-extensions'
import type { SyncProvider } from './sync-provider'

type Props = {
  // The shared CRDT for this document, bound to the editor by the Collaboration extension. Stable for
  // the component's lifetime — the page recreates it (and remounts this editor) when the doc id changes.
  doc: Doc
  // The hand-built sync provider; the caret extension reads its awareness to draw other people's cursors.
  provider: SyncProvider
  userName: string
  userColor: string
  // false → a read-only viewer: TipTap makes the surface non-editable, so keystrokes never even become Yjs
  // updates to send. This mirrors the server's read-only enforcement (M6) in the UI so a reader isn't left
  // typing into a void — but the server stays the real guard; `editable` is convenience, not security.
  editable: boolean
}

// The TipTap editor, bound to Yjs. Collaboration replaces the editor's own document storage with the
// Y.Doc (so every keystroke becomes a Yjs update the provider streams), and CollaborationCaret paints
// the other participants' cursors and selections from awareness. The content schema comes from the
// shared documentExtensions — the same schema the sync layer's updates describe.
export const CollaborativeEditor = ({ doc, provider, userName, userColor, editable }: Props) => {
  const editor = useEditor({
    editable,
    extensions: [
      ...documentExtensions,
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({ provider, user: { name: userName, color: userColor } }),
    ],
    editorProps: {
      attributes: {
        class: 'editor-surface',
        'aria-label': editable ? 'Document editor' : 'Document, view only',
      },
    },
  })

  return <EditorContent editor={editor} />
}
