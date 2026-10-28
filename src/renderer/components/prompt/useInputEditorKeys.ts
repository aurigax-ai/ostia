import { type KeyboardEvent, type MutableRefObject, type RefObject, useRef } from 'react'
import { copyTextConfirmed } from '@/lib/capture/copyConfirm'
import { execChord, isAppChord, matchTerminalChord } from '@/lib/keyboard/chords'
import { smartClipboardAction } from '@/lib/keyboard/clipboardKeys'
import { clipboardChordOf } from '@/lib/keyboard/documentClipboard'
import { escAction } from '@/lib/prompt/escClear'
import { type CompletionItem, caretOnFirstLine, suggestionWord } from '@/lib/prompt/inputEditor'
import { applyLineEdit, lineEditOp, shellKeyBytes } from '@/lib/prompt/lineEditing'
import { enterNormal, type VimMode } from '@/lib/prompt/vimMode'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { InputCompletion } from './useInputCompletion'
import type { InputDraft, Menu } from './useInputDraft'
import type { InputHistory } from './useInputHistory'
import type { InputSuggestions, NaturalCommands } from './useInputSuggestions'
import { type InputVim, onNormalKey } from './useInputVim'

function onMenuKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  open: Menu,
  { setMenu, pick }: { setMenu: (next: Menu | null) => void; pick: (item: CompletionItem) => void },
): boolean {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  if (!plain) return false
  const count = open.matches.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    setMenu({ ...open, index: (open.index + step + count) % count })
    return true
  }
  if (open.auto && e.key === 'Enter') return false
  const area = e.currentTarget
  const atWordEnd =
    area.selectionStart === area.selectionEnd && !/\S/.test(area.value[area.selectionEnd] ?? '')
  if (e.key === 'Enter' || e.key === 'Tab' || (open.auto && e.key === 'ArrowRight' && atWordEnd)) {
    e.preventDefault()
    pick(open.matches[open.index].item)
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    setMenu(null)
    return true
  }
  return false
}

function onNaturalKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  open: NaturalCommands,
  { setNatural, pickNatural, setNaturalDismissed }: InputSuggestions,
  text: string,
): boolean {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  if (!plain) return false
  const count = open.items.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    setNatural({ ...open, index: (open.index + step + count) % count })
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    pickNatural(open.items[open.index])
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    setNaturalDismissed(text)
    return true
  }
  return false
}

const acceptWordChord = (e: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  isMac
    ? e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyF'
    : e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowRight'

function onLineEditKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  {
    draft: { text, walk, replaceText },
    killRing,
    stepHistory,
    onShellKeys,
    handOff,
    followMenu,
  }: {
    draft: InputDraft
    killRing: MutableRefObject<string>
    stepHistory: (dir: 'older' | 'newer') => boolean
    onShellKeys: (keys: string) => void
    handOff: (keys: string) => void
    followMenu: (draft: string, start: number, end: number) => void
  },
): boolean {
  const area = e.currentTarget
  const op = lineEditOp(e)
  if (!op || (isMac && e.altKey)) return false
  e.preventDefault()
  if (op === 'historyPrev' || op === 'historyNext') {
    stepHistory(op === 'historyPrev' ? 'older' : 'newer')
    return true
  }
  if (op === 'clearScreen') {
    onShellKeys('\x0c')
    return true
  }
  if (op === 'deleteChar' && text === '') {
    handOff('\x04')
    return true
  }
  const result = applyLineEdit(op, { text, caret: area.selectionStart }, killRing.current)
  if (result.killed) killRing.current = result.killed
  if (result.text !== text) walk.current = null
  replaceText(result.text, result.caret)
  followMenu(result.text, result.caret, result.caret)
  return true
}

export function useInputEditorKeys({
  draft,
  vim,
  vimModeRef,
  vimEnabled,
  escapeClears,
  normal,
  completion: { menuShown, pick, followMenu, complete },
  suggestions,
  history: { stepHistory },
  composing,
  termRef,
  paneId,
  onSubmit,
  onHandOffRef,
  onShellKeys,
}: {
  draft: InputDraft
  vim: InputVim
  vimModeRef: MutableRefObject<VimMode>
  vimEnabled: boolean
  escapeClears: boolean
  normal: boolean
  completion: InputCompletion
  suggestions: InputSuggestions
  history: InputHistory
  composing: boolean
  termRef: RefObject<Xterm | null>
  paneId: string
  onSubmit: (text: string) => boolean
  onHandOffRef: MutableRefObject<(draft: string, keys: string) => void>
  onShellKeys: (keys: string) => void
}): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const killRing = useRef('')
  const {
    text,
    tip,
    setText,
    setSelection,
    setTip,
    walk,
    restore,
    setMenu,
    setDismissed,
    replaceText,
    resetDraftState,
  } = draft
  const { naturalOpen, suggestion, ghost, acceptSuggestion } = suggestions
  const { setVimMode, undo } = vim

  const submit = (): void => {
    if (!onSubmit(text)) return
    setText('')
    setSelection({ start: 0, end: 0 })
    resetDraftState()
    undo.current = []
    if (vimEnabled) setVimMode('insert')
  }

  const clearDraft = (): void => {
    setText('')
    setSelection({ start: 0, end: 0 })
    resetDraftState()
  }

  const onEscape = (area: HTMLTextAreaElement): void => {
    const action = escAction({
      vim: vimEnabled,
      suggestion: Boolean(suggestion),
      clears: escapeClears,
      text,
      armed: tip === 'escAgain',
    })
    if (action === 'normal') {
      const next = enterNormal({ text, caret: area.selectionStart })
      setVimMode('normal')
      replaceText(next.text, next.caret)
    } else if (action === 'dismiss') {
      setDismissed(text)
    } else if (action === 'arm') {
      setTip('escAgain')
    } else if (action === 'clear') {
      restore.current = text
      clearDraft()
      setTip('cleared')
    }
  }

  const handOff = (keys: string): void => {
    const typed = text
    setText('')
    setSelection({ start: 0, end: 0 })
    resetDraftState()
    undo.current = []
    onHandOffRef.current(typed, keys)
  }

  return (e) => {
    if (e.nativeEvent.isComposing || composing) return
    const area = e.currentTarget
    if (naturalOpen && onNaturalKey(e, naturalOpen, suggestions, text)) return
    if (menuShown && onMenuKey(e, menuShown, { setMenu, pick })) return
    const scoped = matchTerminalChord(e, isMac)
    if (isAppChord(scoped)) {
      e.preventDefault()
      e.stopPropagation()
      execChord(scoped, e)
      return
    }
    if (e.key === 'Home' || e.key === 'End' || e.key === 'Escape') setMenu(null)
    if (normal && onNormalKey(e, { vim, vimModeRef, draft, submit, stepHistory })) return
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'Enter' && plain && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && plain && !e.shiftKey) {
      e.preventDefault()
      onEscape(area)
      return
    }
    const ctrlOnly = e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey
    if (e.key.toLowerCase() === 'z' && ctrlOnly && tip === 'cleared' && text === '') {
      e.preventDefault()
      const back = restore.current
      restore.current = ''
      setTip('none')
      replaceText(back)
      return
    }
    if (suggestion && plain && !e.shiftKey && (e.key === 'ArrowRight' || e.key === 'End')) {
      e.preventDefault()
      acceptSuggestion(suggestion)
      return
    }
    if (suggestion && acceptWordChord(e)) {
      e.preventDefault()
      acceptSuggestion(suggestionWord(suggestion))
      return
    }
    if (e.key === 'Tab' && plain && !e.shiftKey) {
      e.preventDefault()
      if (ghost?.kind === 'ai') acceptSuggestion(ghost.text)
      else void complete(area)
      return
    }
    const draftSelection = text.slice(area.selectionStart, area.selectionEnd)
    const term = termRef.current
    const smart = smartClipboardAction(
      e,
      useSettingsStore.getState().terminal.clipboardKeys,
      Boolean(draftSelection) || Boolean(term?.hasSelection()),
      isMac,
    )
    if (smart === 'paste') return
    if (smart === 'copy' || clipboardChordOf(e, isMac) === 'copy') {
      e.preventDefault()
      if (draftSelection) void copyTextConfirmed(paneId, draftSelection)
      else if (term?.hasSelection()) {
        void copyTextConfirmed(paneId, term.getSelection())
        if (smart) term.clearSelection()
      }
      return
    }
    if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      clearDraft()
      return
    }
    if (onLineEditKey(e, { draft, killRing, stepHistory, onShellKeys, handOff, followMenu })) return
    const keys = isMac && e.altKey ? null : shellKeyBytes(e)
    if (keys) {
      e.preventDefault()
      handOff(keys)
      return
    }
    const collapsed = area.selectionStart === area.selectionEnd
    if (e.key === 'ArrowUp' && plain && !e.shiftKey && collapsed) {
      const walking = walk.current !== null
      if ((walking || caretOnFirstLine(text, area.selectionStart)) && stepHistory('older')) {
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown' && plain && !e.shiftKey && collapsed && walk.current) {
      if (stepHistory('newer')) e.preventDefault()
    }
  }
}
