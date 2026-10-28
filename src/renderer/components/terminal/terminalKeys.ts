import { isNativeClipboardKey } from '@shared/keyboard/chordSpec'
import { commands } from '@/commands/registry'
import { confirmNativeCopy, copyTextConfirmed } from '@/lib/capture/copyConfirm'
import {
  execChord,
  findStep,
  isAppChord,
  isBrowserChord,
  isTerminalCommandChord,
  matchChord,
  matchTerminalChord,
} from '@/lib/keyboard/chords'
import { smartClipboardAction } from '@/lib/keyboard/clipboardKeys'
import { terminalKeyData } from '@/lib/keyboard/keyPresets'
import { isRemappedEvent } from '@/lib/keyboard/modifierRemapEvents'
import { stepBlock } from '@/lib/terminal/blockActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { inputEditorFor } from '@/lib/terminal/terminalHandles'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'

export function attachTerminalKeys({
  host,
  term,
  paneId,
  pasteFromClipboard,
  setFindOpen,
  findStepRef,
}: {
  host: HTMLElement
  term: OstiaTerminal
  paneId: string
  pasteFromClipboard: () => void
  setFindOpen: (open: boolean) => void
  findStepRef: { current: ((by: number) => void) | null }
}): () => void {
  const focusEditorOnClick = (e: MouseEvent): void => {
    if (e.button !== 0 || term.hasSelection()) return
    inputEditorFor(paneId)?.focus()
  }
  host.addEventListener('mouseup', focusEditorOnClick)
  const confirmNativeSelectionCopy = (): void => {
    if (term.hasSelection()) confirmNativeCopy(paneId)
  }
  host.addEventListener('copy', confirmNativeSelectionCopy)

  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const blocks = useBlocksStore.getState()
      if (!blocks.selected[paneId]) return true
      if (e.type === 'keydown') blocks.select(paneId, null)
      return false
    }
    const smart = smartClipboardAction(
      e,
      useSettingsStore.getState().terminal.clipboardKeys,
      term.hasSelection(),
      isMac,
    )
    if (smart) {
      if (e.type !== 'keydown') return false
      e.preventDefault()
      if (smart === 'copy') {
        void copyTextConfirmed(paneId, term.getSelection())
        term.clearSelection()
      } else {
        pasteFromClipboard()
      }
      return false
    }
    const scoped = matchTerminalChord(e, isMac)
    if (scoped && e.type === 'keydown') e.stopPropagation()
    if (isAppChord(scoped)) {
      if (e.type === 'keydown') {
        e.preventDefault()
        execChord(scoped, e)
      }
      return false
    }
    const chord = scoped ?? matchChord(e, isMac)
    if (!chord || isBrowserChord(chord)) {
      const sent = terminalKeyData(e, isMac)
      if (sent && !inputEditorFor(paneId)) {
        if (e.type === 'keydown') {
          e.preventDefault()
          term.input(sent, true)
        }
        return false
      }
      if (chord) return true
      const editor = inputEditorFor(paneId)
      if (!editor) return true
      if (e.type !== 'keydown') return false
      e.preventDefault()
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
      if (printable) editor.type(e.key)
      else editor.focus()
      return false
    }
    const clipboard = chord === 'copy' || chord === 'paste'
    if (isMac && clipboard && isNativeClipboardKey(e) && !isRemappedEvent(e)) return true
    if (e.type !== 'keydown' || isAppChord(chord)) return false
    e.preventDefault()
    const findBy = findStep(chord)
    if (chord === 'find') setFindOpen(true)
    else if (findBy !== null) {
      if (findStepRef.current) findStepRef.current(findBy)
      else setFindOpen(true)
    } else if (chord === 'block.selectPrev') stepBlock(paneId, 'prev')
    else if (chord === 'block.selectNext') stepBlock(paneId, 'next')
    else if (isTerminalCommandChord(chord)) void commands.exec(chord)
    else if (chord === 'copy') {
      const selection = term.getSelection()
      if (selection) void copyTextConfirmed(paneId, selection)
    } else {
      pasteFromClipboard()
    }
    return false
  })

  return () => {
    host.removeEventListener('mouseup', focusEditorOnClick)
    host.removeEventListener('copy', confirmNativeSelectionCopy)
  }
}
