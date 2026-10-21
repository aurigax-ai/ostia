import {
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  applyVimCommand,
  canMoveVertically,
  parseVimKeys,
  type VimBuffer,
  type VimMode,
} from '@/lib/prompt/vimMode'
import type { InputDraft, Menu } from './useInputDraft'

const UNDO_LIMIT = 100

export interface InputVim {
  vimMode: VimMode
  setVimModeState: Dispatch<SetStateAction<VimMode>>
  vimPending: string
  setVimPending: Dispatch<SetStateAction<string>>
  undo: MutableRefObject<VimBuffer[]>
  setVimMode: (mode: VimMode) => void
}

export function useInputVim({
  vimEnabled,
  vimModeRef,
  setMenu,
}: {
  vimEnabled: boolean
  vimModeRef: MutableRefObject<VimMode>
  setMenu: (next: Menu | null) => void
}): InputVim {
  const [vimMode, setVimModeState] = useState<VimMode>('insert')
  const [vimPending, setVimPending] = useState('')
  const undo = useRef<VimBuffer[]>([])

  const setVimMode = (mode: VimMode): void => {
    vimModeRef.current = mode
    setVimModeState(mode)
    setVimPending('')
    if (mode === 'normal') setMenu(null)
  }

  useEffect(() => {
    if (vimEnabled) return
    vimModeRef.current = 'insert'
    setVimModeState('insert')
    setVimPending('')
  }, [vimEnabled, vimModeRef])

  return { vimMode, setVimModeState, vimPending, setVimPending, undo, setVimMode }
}

export function onNormalKey(
  e: KeyboardEvent<HTMLTextAreaElement>,
  {
    vim: { vimPending, setVimPending, undo, setVimMode },
    vimModeRef,
    draft: { text, walk, replaceText },
    submit,
    handOff,
    stepHistory,
  }: {
    vim: InputVim
    vimModeRef: MutableRefObject<VimMode>
    draft: InputDraft
    submit: () => void
    handOff: (keys: string) => void
    stepHistory: (dir: 'older' | 'newer') => boolean
  },
): boolean {
  const area = e.currentTarget
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (vimPending) setVimPending('')
    else handOff('')
    return true
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault()
    return true
  }
  if (e.key.length !== 1) return false
  e.preventDefault()
  const keys = vimPending + e.key
  const command = parseVimKeys(keys)
  if (command === 'pending') {
    setVimPending(keys)
    return true
  }
  setVimPending('')
  if (!command) return true
  const caret = area.selectionStart
  if (command.kind === 'undo') {
    let restored: VimBuffer | undefined
    for (let n = 0; n < command.count; n++) restored = undo.current.pop() ?? restored
    if (restored) replaceText(restored.text, restored.caret)
    return true
  }
  if (command.kind === 'move' && (command.motion === 'j' || command.motion === 'k')) {
    const down = command.motion === 'j'
    if (!canMoveVertically(text, caret, down)) {
      if (!down || walk.current) stepHistory(down ? 'newer' : 'older')
      return true
    }
  }
  if (command.kind !== 'move') {
    undo.current.push({ text, caret })
    if (undo.current.length > UNDO_LIMIT) undo.current.shift()
  }
  const result = applyVimCommand(command, { text, caret })
  if (result.mode !== vimModeRef.current) setVimMode(result.mode)
  if (result.text !== text) walk.current = null
  replaceText(result.text, result.caret)
  return true
}
