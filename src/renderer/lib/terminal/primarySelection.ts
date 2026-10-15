import { debounce } from 'es-toolkit'
import type { OstiaTerminal as Terminal } from './ostiaTerminal'

export const PRIMARY_WRITE_DELAY_MS = 150

const MIDDLE_BUTTON = 1

export interface PrimarySelectionOptions {
  enabled: () => boolean
  writePrimary: (text: string) => void
}

export function installPrimarySelection(
  host: HTMLElement,
  term: Pick<Terminal, 'onSelectionChange' | 'hasSelection' | 'getSelection'>,
  opts: PrimarySelectionOptions,
): () => void {
  const writeSelection = debounce(() => {
    if (opts.enabled() && term.hasSelection()) opts.writePrimary(term.getSelection())
  }, PRIMARY_WRITE_DELAY_MS)
  const selection = term.onSelectionChange(writeSelection)
  const blockMiddlePaste = (e: MouseEvent): void => {
    if (e.button === MIDDLE_BUTTON && !opts.enabled()) e.preventDefault()
  }
  host.addEventListener('mouseup', blockMiddlePaste, true)
  return () => {
    writeSelection.cancel()
    selection.dispose()
    host.removeEventListener('mouseup', blockMiddlePaste, true)
  }
}
