import { useRef, useState } from 'react'
import { API_renameDocument } from '../lib/api'

type Props = {
  documentId: string
  title: string
  // Called with the server's canonical (trimmed) title after a successful rename, so the page header
  // updates to exactly what was stored.
  onRenamed: (title: string) => void
}

// The editor header's title, click-to-rename. Display state is a button (the whole title is the click
// target); editing state is an input that commits on Enter or blur and cancels on Escape.
//
// The tricky part is the blur: closing the input — on save OR on Escape — unmounts it and fires `blur`,
// which would re-run the commit. `skipNextBlur` suppresses exactly that follow-up blur, and we reset it
// every time editing starts so a stale suppression from a prior cycle can never swallow a real blur.
export const DocumentTitle = ({ documentId, title, onRenamed }: Props) => {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [isSaving, setIsSaving] = useState(false)
  const skipNextBlur = useRef(false)

  const startEditing = () => {
    skipNextBlur.current = false
    setDraft(title)
    setIsEditing(true)
  }

  const closeWithoutSaving = () => {
    skipNextBlur.current = true
    setIsEditing(false)
  }

  const commit = async () => {
    const trimmed = draft.trim()
    // Nothing to save: empty (the server would 400 it) or unchanged. Just close.
    if (trimmed === '' || trimmed === title) {
      closeWithoutSaving()
      return
    }
    setIsSaving(true)
    try {
      const { document } = await API_renameDocument(documentId, trimmed)
      onRenamed(document.title)
    } finally {
      setIsSaving(false)
      skipNextBlur.current = true
      setIsEditing(false)
    }
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        title="Rename document"
        className="text-left hover:underline"
      >
        {title}
      </button>
    )
  }

  return (
    <input
      // Clicking the title is an explicit intent to edit now, so focusing immediately is expected.
      // biome-ignore lint/a11y/noAutofocus: focus follows a deliberate click, not an unprompted steal.
      autoFocus
      value={draft}
      disabled={isSaving}
      aria-label="Document title"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (skipNextBlur.current) {
          skipNextBlur.current = false
          return
        }
        void commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          closeWithoutSaving()
        }
      }}
      className="w-full max-w-full rounded border border-slate-300 px-1 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-slate-400"
    />
  )
}
