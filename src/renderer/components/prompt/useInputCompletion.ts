import type { SpecCommand } from '@shared/terminal/completionSpec'
import { type RefObject, useEffect, useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
import {
  type CompletionMatch,
  filterCompletions,
  followDraft,
  keepSelection,
  tabStep,
} from '@/lib/prompt/completionMatch'
import { historyArguments } from '@/lib/prompt/historyArguments'
import {
  applyCompletionItem,
  argumentCandidates,
  type CompletionItem,
  commandCandidates,
  completionScope,
  completionToken,
  escapeAtCaret,
  isCommandWord,
  opensFileMenu,
  recentCommands,
  splitPathWord,
} from '@/lib/prompt/inputEditor'
import type { InputDraft, Menu } from './useInputDraft'
import type { InputHistory } from './useInputHistory'

const MENU_LIMIT = 200
const LIVE_DELAY_MS = 150

function shownMatches(matches: CompletionMatch[]): CompletionMatch[] {
  return matches.length > MENU_LIMIT ? matches.slice(0, MENU_LIMIT) : matches
}

export interface InputCompletion {
  menuShown: Menu | null
  pick: (item: CompletionItem) => void
  followMenu: (draft: string, start: number, end: number) => void
  complete: (area: HTMLTextAreaElement) => Promise<void>
  typed: (draft: string, start: number, end: number) => void
}

export function useInputCompletion({
  paneId,
  cwd,
  draft: { text, menu, liveMenu, setMenu, setTip, areaRef, replaceText },
  menuRef,
  history: { commands, history, facts },
  historySuggestionsOn,
  liveFilesOn,
}: {
  paneId: string
  cwd: string | undefined
  draft: InputDraft
  menuRef: RefObject<HTMLDivElement>
  history: InputHistory
  historySuggestionsOn: boolean
  liveFilesOn: boolean
}): InputCompletion {
  const d = useDict()
  const completing = useRef(0)
  const liveTimer = useRef<number | undefined>(undefined)
  const specs = useRef(new Map<string, Promise<SpecCommand | null>>())
  const menuShown = menu !== null && menu.matches.length > 0 ? menu : null

  const menuOpen = menuShown !== null
  useEffect(() => {
    const root = menuRef.current
    const area = areaRef.current
    if (!menuOpen || !root || !area) return
    const sync = (): void => {
      const list = root.querySelector('[role="listbox"]')
      if (list) area.setAttribute('aria-controls', list.id)
      const active = root.querySelector('[cmdk-item][aria-selected="true"]')
      if (!(active instanceof HTMLElement)) return
      area.setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView?.({ block: 'nearest' })
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
    return () => {
      observer.disconnect()
      area.removeAttribute('aria-activedescendant')
      area.removeAttribute('aria-controls')
    }
  }, [menuOpen, menuRef, areaRef])

  const loadSpec = (command: string): Promise<SpecCommand | null> => {
    const known = specs.current.get(command)
    if (known) return known
    const loading = window.ostia.completions.spec(command).catch(() => null)
    specs.current.set(command, loading)
    return loading
  }

  const pick = (item: CompletionItem): void => {
    const area = areaRef.current
    const caret = area ? area.selectionStart : text.length
    const next = applyCompletionItem(text, caret, item)
    setMenu(null)
    setTip('none')
    replaceText(next.text, next.caret)
  }

  const candidatesAt = (draft: string, caret: number): Promise<CompletionItem[]> =>
    isCommandWord(draft, caret)
      ? Promise.resolve(commandCandidates(commands ?? [], recentCommands(history)))
      : argumentCandidates(draft, caret, cwd ?? '~', {
          spec: loadSpec,
          list: (p) => window.ostia.pty.listDir(paneId, p),
          history: historySuggestionsOn
            ? {
                arguments: (before) => historyArguments(before, facts),
                label: d.inputEditor.fromHistory,
              }
            : undefined,
        })

  const relist = async (draft: string, caret: number): Promise<void> => {
    const ticket = ++completing.current
    const pool = await candidatesAt(draft, caret)
    const live = liveMenu.current
    const area = areaRef.current
    if (ticket !== completing.current || !live || !area) return
    const origin = { ...live.origin, pool }
    const step = followDraft(origin, area.value, area.selectionStart)
    if (step.kind !== 'filter') return
    setMenu({ origin, matches: shownMatches(step.matches), index: 0, auto: live.auto })
  }

  const followMenu = (draft: string, start: number, end: number): void => {
    const live = liveMenu.current
    if (!live) return
    if (start !== end) {
      setMenu(null)
      return
    }
    const step = followDraft(live.origin, draft, start)
    if (step.kind === 'close') {
      setMenu(null)
    } else if (step.kind === 'relist') {
      setMenu({
        origin: { ...live.origin, scope: step.scope, pool: [] },
        matches: [],
        index: 0,
        auto: live.auto,
      })
      void relist(draft, start)
    } else {
      const matches = shownMatches(step.matches)
      setMenu({ ...live, matches, index: keepSelection(live.matches, live.index, matches) })
    }
  }

  const complete = async (area: HTMLTextAreaElement): Promise<void> => {
    const caret = area.selectionStart
    const ticket = ++completing.current
    const commandWord = isCommandWord(text, caret)
    const { start, word } = completionToken(text, caret)
    const pool = await candidatesAt(text, caret)
    if (ticket !== completing.current) return
    const step = tabStep(pool, splitPathWord(word).base)
    if (step.kind === 'none') {
      setMenu(null)
      setTip(commandWord ? 'noCommands' : 'noPaths')
      return
    }
    setTip('none')
    if (step.kind === 'pick') {
      const next = applyCompletionItem(text, caret, step.item)
      setMenu(null)
      replaceText(next.text, next.caret)
      return
    }
    if (step.extend) {
      const insert = escapeAtCaret(text, caret, step.extend)
      replaceText(text.slice(0, caret) + insert + text.slice(caret), caret + insert.length)
    }
    const origin = { start, scope: completionScope(word), pool }
    setMenu({ origin, matches: shownMatches(step.matches), index: 0 })
  }

  const openLive = async (): Promise<void> => {
    const area = areaRef.current
    if (!area || liveMenu.current || area.selectionStart !== area.selectionEnd) return
    const draft = area.value
    const caret = area.selectionStart
    if (!opensFileMenu(draft, caret)) return
    const ticket = ++completing.current
    const pool = await candidatesAt(draft, caret)
    const current = areaRef.current
    if (ticket !== completing.current || liveMenu.current || !current) return
    if (current.value !== draft || current.selectionStart !== caret) return
    const { start, word } = completionToken(draft, caret)
    const matches = filterCompletions(pool, splitPathWord(word).base)
    if (matches.length === 0) return
    const origin = { start, scope: completionScope(word), pool }
    setMenu({ origin, matches: shownMatches(matches), index: 0, auto: true })
  }

  const typed = (draft: string, start: number, end: number): void => {
    window.clearTimeout(liveTimer.current)
    followMenu(draft, start, end)
    if (!liveFilesOn || liveMenu.current || start !== end || !opensFileMenu(draft, start)) return
    liveTimer.current = window.setTimeout(
      () => void openLive().catch(() => undefined),
      LIVE_DELAY_MS,
    )
  }

  useEffect(() => () => window.clearTimeout(liveTimer.current), [])

  return { menuShown, pick, followMenu, complete, typed }
}
