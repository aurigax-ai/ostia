import { useEffect, useMemo, useState } from 'react'
import { historyHiddenFrom } from '@/lib/panes/scratchPanes'
import {
  fileOnlyCommands,
  type HistoryFacts,
  historyFacts,
  sessionBlocks,
} from '@/lib/prompt/historyRank'
import { historyMatches, inputHistory } from '@/lib/prompt/inputEditor'
import { useFileHistory } from '@/lib/prompt/useFileHistory'
import type { CommandBlock, LineAnchor } from '@/stores/terminal/blocksStore'
import type { InputDraft } from './useInputDraft'

export interface InputHistory {
  commands: string[] | null
  commandSet: ReadonlySet<string> | null
  history: string[]
  facts: readonly HistoryFacts[]
  stepHistory: (dir: 'older' | 'newer') => boolean
}

export function useInputHistory({
  paneId,
  visible,
  promptLine,
  byPane,
  historySuggestionsOn,
  draft: { text, walk, setMenu, replaceText },
}: {
  paneId: string
  visible: boolean
  promptLine: LineAnchor | undefined
  byPane: Record<string, CommandBlock[] | undefined>
  historySuggestionsOn: boolean
  draft: InputDraft
}): InputHistory {
  const [commands, setCommands] = useState<string[] | null>(null)
  const [localPrompt, setLocalPrompt] = useState(true)
  const history = useMemo(
    () => (localPrompt ? inputHistory(byPane, paneId, historyHiddenFrom(paneId)) : []),
    [byPane, paneId, localPrompt],
  )
  const commandSet = useMemo(() => (commands ? new Set(commands) : null), [commands])
  const fileHistory = useFileHistory(
    paneId,
    visible && localPrompt && historySuggestionsOn,
    promptLine,
  )
  const facts = useMemo(
    () =>
      localPrompt && historySuggestionsOn
        ? historyFacts(fileHistory, sessionBlocks(byPane, paneId, historyHiddenFrom(paneId)))
        : [],
    [fileHistory, byPane, paneId, localPrompt, historySuggestionsOn],
  )
  const fileOnly = useMemo(() => fileOnlyCommands(fileHistory, history), [fileHistory, history])

  useEffect(() => {
    if (!visible || !promptLine) return
    let live = true
    window.ostia.pty
      .commands(paneId)
      .then((names) => {
        if (live) setCommands(names.length > 0 ? names : null)
      })
      .catch(() => {})
    window.ostia.pty
      .localPrompt(paneId)
      .then((local) => {
        if (live) setLocalPrompt(local)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [paneId, visible, promptLine])

  const stepHistory = (dir: 'older' | 'newer'): boolean => {
    const state = walk.current ?? {
      index: -1,
      saved: text,
      entries: [...historyMatches(history, text), ...(text ? historyMatches(fileOnly, text) : [])],
    }
    const index = dir === 'older' ? state.index + 1 : state.index - 1
    if (index >= state.entries.length || index < -1) return false
    walk.current = index === -1 ? null : { ...state, index }
    setMenu(null)
    replaceText(index === -1 ? state.saved : state.entries[index])
    return true
  }

  return { commands, commandSet, history, facts, stepHistory }
}
