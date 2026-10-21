import { useState } from 'react'
import {
  ASK_CONTEXT_ORDER,
  type AskContextKind,
  askContextOptions,
  selectionRef,
  useWorkspaceEditorFile,
} from '@/lib/assist/askContext'
import { useLiveSelectionStore } from '@/stores/terminal/liveSelectionStore'

interface ChatContextParams {
  workspaceId: string | null
  labels: Record<AskContextKind, string>
}

export function useChatContext({ workspaceId, labels }: ChatContextParams) {
  const [options, setOptions] = useState(() => askContextOptions(labels, workspaceId))
  const [enabled, setEnabled] = useState<ReadonlySet<AskContextKind>>(
    () => new Set<AskContextKind>(options.cwd ? ['cwd', 'editor'] : ['editor']),
  )
  const [seenText, setSeenText] = useState<string | undefined>(undefined)
  const editorFile = useWorkspaceEditorFile(workspaceId)
  const liveSelection = useLiveSelectionStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : undefined,
  )
  const selectedText = liveSelection?.text
  if (selectedText !== seenText) {
    setSeenText(selectedText)
    if (selectedText && !enabled.has('selection')) {
      setEnabled(new Set([...enabled, 'selection']))
    }
  }

  const toggle = (kind: AskContextKind): void =>
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const available = ASK_CONTEXT_ORDER.filter((kind) => {
    if (kind === 'selection') return liveSelection !== undefined
    if (kind === 'editor') return editorFile !== null
    return options[kind]
  })
  const selectedRef = liveSelection ? selectionRef(liveSelection) : null
  return { options, setOptions, enabled, toggle, editorFile, selectedText, available, selectedRef }
}

export type ChatContext = ReturnType<typeof useChatContext>
