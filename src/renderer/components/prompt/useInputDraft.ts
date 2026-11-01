import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { CompletionMatch, CompletionOrigin } from '@/lib/prompt/completionMatch'
import { ESC_ARM_MS, ESC_CLEARED_MS } from '@/lib/prompt/escClear'
import type { VimMode } from '@/lib/prompt/vimMode'
import { clampNormal } from '@/lib/prompt/vimMode'
import { registerInputEditor } from '@/lib/terminal/terminalHandles'

type Tip = 'none' | 'noPaths' | 'noCommands' | 'escAgain' | 'cleared'

export interface Menu {
  origin: CompletionOrigin
  matches: CompletionMatch[]
  index: number
  auto?: boolean
}

interface Selection {
  start: number
  end: number
}

interface HistoryWalk {
  index: number
  saved: string
  entries: string[]
}

export interface InputDraft {
  text: string
  setText: Dispatch<SetStateAction<string>>
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
  tip: Tip
  setTip: Dispatch<SetStateAction<Tip>>
  menu: Menu | null
  setMenu: (next: Menu | null) => void
  liveMenu: MutableRefObject<Menu | null>
  dismissed: string | null
  setDismissed: Dispatch<SetStateAction<string | null>>
  areaRef: RefObject<HTMLTextAreaElement | null>
  textRef: MutableRefObject<string>
  walk: MutableRefObject<HistoryWalk | null>
  restore: MutableRefObject<string>
  replaceText: (next: string, caret?: number) => void
  resetDraftState: () => void
  typeAtCaret: (chunk: string) => void
}

export function useInputDraft({
  paneId,
  visible,
  vimEnabled,
  vimModeRef,
}: {
  paneId: string
  visible: boolean
  vimEnabled: boolean
  vimModeRef: MutableRefObject<VimMode>
}): InputDraft {
  const [text, setText] = useState('')
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 })
  const [tip, setTip] = useState<Tip>('none')
  const [menu, setMenuState] = useState<Menu | null>(null)
  const liveMenu = useRef<Menu | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const walk = useRef<HistoryWalk | null>(null)
  const restore = useRef('')
  const pendingCaret = useRef<number | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  const setMenu = (next: Menu | null): void => {
    liveMenu.current = next
    setMenuState(next)
  }

  const replaceText = (next: string, caret = next.length): void => {
    const at = vimModeRef.current === 'normal' && vimEnabled ? clampNormal(next, caret) : caret
    setText(next)
    setSelection({ start: at, end: at })
    pendingCaret.current = at
  }

  useEffect(() => {
    const ms = tip === 'escAgain' ? ESC_ARM_MS : tip === 'cleared' ? ESC_CLEARED_MS : 0
    if (!ms) return
    const timer = window.setTimeout(() => setTip('none'), ms)
    return () => window.clearTimeout(timer)
  }, [tip])

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const area = areaRef.current
    if (caret === null || !area) return
    pendingCaret.current = null
    area.setSelectionRange(caret, caret)
  })

  const resetDraftState = (): void => {
    walk.current = null
    setTip('none')
    setMenu(null)
    setDismissed(null)
  }

  useEffect(() => {
    if (!visible) return
    return registerInputEditor(paneId, {
      insert: (command) => {
        setText(command)
        setSelection({ start: command.length, end: command.length })
        pendingCaret.current = command.length
        walk.current = null
        setTip('none')
        liveMenu.current = null
        setMenuState(null)
        areaRef.current?.focus()
      },
      type: (chunk) => {
        const area = areaRef.current
        const current = textRef.current
        const start = area ? area.selectionStart : current.length
        const end = area ? area.selectionEnd : current.length
        const next = current.slice(0, start) + chunk + current.slice(end)
        setText(next)
        setSelection({ start: start + chunk.length, end: start + chunk.length })
        pendingCaret.current = start + chunk.length
        walk.current = null
        liveMenu.current = null
        setMenuState(null)
        area?.focus()
      },
      focus: () => areaRef.current?.focus(),
      take: () => {
        const taken = textRef.current
        setText('')
        setSelection({ start: 0, end: 0 })
        walk.current = null
        setTip('none')
        liveMenu.current = null
        setMenuState(null)
        return taken
      },
    })
  }, [paneId, visible])

  const typeAtCaret = (chunk: string): void => {
    const area = areaRef.current
    const current = textRef.current
    const start = area ? area.selectionStart : current.length
    const end = area ? area.selectionEnd : current.length
    replaceText(current.slice(0, start) + chunk + current.slice(end), start + chunk.length)
    walk.current = null
    area?.focus()
  }

  return {
    text,
    setText,
    selection,
    setSelection,
    tip,
    setTip,
    menu,
    setMenu,
    liveMenu,
    dismissed,
    setDismissed,
    areaRef,
    textRef,
    walk,
    restore,
    replaceText,
    resetDraftState,
    typeAtCaret,
  }
}
