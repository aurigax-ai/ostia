import type { CommandSuggestion } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react'
import { latestRequest, naturalCommandQuery } from '@/lib/assist/assistComposer'
import {
  type AssistFeatureRef,
  featureEnabled,
  useAssistFeature,
} from '@/lib/assist/assistFeatures'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { everyChip, promptExtensionChips } from '@/lib/extensions/extensionChips'
import { rankedSuggestion } from '@/lib/prompt/historyRank'
import {
  type AiGhost,
  chipContext,
  type Ghost,
  type GhostBlockers,
  ghostBlocked,
  ghostEligible,
  ghostRequester,
  pickGhost,
  recentHistory,
  terminalRequest,
} from '@/lib/prompt/terminalGhost'
import { platform } from '@/platform'
import { assistRequest, useAssistProvider } from '@/stores/assist/assistStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { type CommandBlock, useBlocksStore } from '@/stores/terminal/blocksStore'
import type { InputDraft, Menu } from './useInputDraft'
import type { InputHistory } from './useInputHistory'

const NATURAL_COMMAND_DEBOUNCE_MS = 600

export interface NaturalCommands {
  for: string
  items: CommandSuggestion[]
  index: number
}

export interface InputSuggestions {
  naturalOpen: NaturalCommands | null
  setNatural: Dispatch<SetStateAction<NaturalCommands | null>>
  setNaturalDismissed: Dispatch<SetStateAction<string | null>>
  pickNatural: (item: CommandSuggestion) => void
  ghostFeature: AssistFeatureRef | null
  ghost: Ghost
  suggestion: string
  acceptSuggestion: (part: string) => void
}

export function useInputSuggestions({
  paneId,
  cwd,
  visible,
  draft: { text, selection, dismissed, setDismissed, walk, setMenu, replaceText },
  composing,
  normal,
  menuShown,
  historySuggestionsOn,
  history: { facts, commandSet },
  byPane,
}: {
  paneId: string
  cwd: string | undefined
  visible: boolean
  draft: InputDraft
  composing: boolean
  normal: boolean
  menuShown: Menu | null
  historySuggestionsOn: boolean
  history: InputHistory
  byPane: Record<string, CommandBlock[] | undefined>
}): InputSuggestions {
  const [natural, setNatural] = useState<NaturalCommands | null>(null)
  const [naturalDismissed, setNaturalDismissed] = useState<string | null>(null)
  const naturalRequest = useRef(latestRequest())
  const commandAssist = useAssistProvider('command')
  const terminalAssist = useAssistProvider('terminal')
  const ghostFeature = useAssistFeature('terminalCompletions')
  const ghostOn = visible && Boolean(terminalAssist) && featureEnabled(ghostFeature)
  const [aiGhost, setAiGhost] = useState<AiGhost | null>(null)
  const ghostContext = useRef({ paneId, cwd })
  ghostContext.current = { paneId, cwd }
  const [ghostRequest] = useState(() =>
    ghostRequester(async (line, signal) => {
      const { paneId: pane, cwd: dir } = ghostContext.current
      const ext = useExtensionsStore.getState()
      const chips = promptExtensionChips(
        ext.chips,
        ext.workspaceChips,
        everyChip(ext.list),
        pane,
        workspaceOfPane(pane) ?? null,
      )
      const req = terminalRequest(line, {
        cwd: dir,
        platform,
        history: recentHistory(useBlocksStore.getState().byPane[pane]),
        context: chipContext(chips),
      })
      const res = await assistRequest('terminal', req, { signal })
      return res.ok ? res.result.text : null
    }, setAiGhost),
  )

  useEffect(() => {
    const request = naturalRequest.current
    const query = visible && commandAssist ? naturalCommandQuery(text) : null
    if (!query) {
      request.cancel()
      return
    }
    request.run(async (signal) => {
      const res = await assistRequest(
        'command',
        { query, ...(cwd ? { cwd } : {}), platform },
        { signal },
      )
      if (signal.aborted || !res.ok || res.result.suggestions.length === 0) return
      setNatural({ for: text, items: res.result.suggestions, index: 0 })
    }, NATURAL_COMMAND_DEBOUNCE_MS)
  }, [text, visible, commandAssist, cwd])

  useEffect(() => {
    const request = naturalRequest.current
    return () => request.cancel()
  }, [])

  const naturalOpen =
    visible && !menuShown && natural !== null && natural.for === text && naturalDismissed !== text
      ? natural
      : null

  const blockers: GhostBlockers = {
    composing,
    vimNormal: normal,
    menuOpen: menuShown !== null,
    naturalOpen: naturalOpen !== null,
    walking: walk.current !== null,
    collapsed: selection.start === selection.end,
    caretAtEnd: selection.end === text.length,
    dismissed: dismissed === text,
  }
  const blocked = ghostBlocked(blockers)
  const historyText =
    visible && !blocked && historySuggestionsOn
      ? rankedSuggestion(text, facts, {
          cwd: cwd ?? null,
          previous: byPane[paneId]?.at(-1)?.command.trim() || null,
          commands: commandSet,
        })
      : ''
  const ghost = visible ? pickGhost(text, blockers, historyText, ghostOn ? aiGhost : null) : null
  const suggestion = ghost?.text ?? ''

  const acceptSuggestion = (part: string): void => {
    setMenu(null)
    replaceText(text + part)
    setDismissed(null)
  }

  useEffect(() => {
    const request = ghostRequest
    if (!ghostOn || blocked || historyText || !ghostEligible(text)) {
      request.cancel()
      return
    }
    request.request(text)
  }, [text, ghostOn, blocked, historyText, ghostRequest])

  useEffect(() => () => ghostRequest.cancel(), [ghostRequest])

  const pickNatural = (item: CommandSuggestion): void => {
    setNatural(null)
    setMenu(null)
    replaceText(item.command)
  }

  return {
    naturalOpen,
    setNatural,
    setNaturalDismissed,
    pickNatural,
    ghostFeature,
    ghost,
    suggestion,
    acceptSuggestion,
  }
}
