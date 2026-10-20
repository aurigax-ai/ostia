import { scrollUpSequence } from '@/lib/prompt/promptOverlay'
import { canTypeInto, insertCommand } from '@/lib/terminal/blockActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'

interface TerminalInputBridge {
  submitInput: (text: string) => boolean
  handOffInput: (draft: string, keys: string) => void
  sendShellKeys: (keys: string) => void
  makeRows: (rows: number) => void
}

export function terminalInputBridge({
  paneId,
  termRef,
  setSuppressedPrompt,
}: {
  paneId: string
  termRef: { current: OstiaTerminal | null }
  setSuppressedPrompt: (prompt: LineAnchor | null) => void
}): TerminalInputBridge {
  const submitInput = (text: string): boolean => {
    if (!canTypeInto(paneId)) return false
    setSuppressedPrompt(useBlocksStore.getState().drafts[paneId]?.promptLine ?? null)
    if (text) return insertCommand(paneId, text, true)
    termRef.current?.focus()
    window.ostia.pty.write(paneId, '\r', true)
    return true
  }

  const handOffInput = (draft: string, keys: string): void => {
    const term = termRef.current
    if (!term || !canTypeInto(paneId)) return
    setSuppressedPrompt(useBlocksStore.getState().drafts[paneId]?.promptLine ?? null)
    term.focus()
    if (draft) term.paste(draft)
    if (keys) window.ostia.pty.write(paneId, keys, true)
  }

  const sendShellKeys = (keys: string): void => {
    if (canTypeInto(paneId)) window.ostia.pty.write(paneId, keys, true)
  }

  const makeRows = (rows: number): void => {
    const term = termRef.current
    if (!term || rows <= 0) return
    const buf = term.buffer.active
    term.write(scrollUpSequence(term.rows, buf.cursorY, buf.cursorX, rows))
  }

  return { submitInput, handOffInput, sendShellKeys, makeRows }
}
