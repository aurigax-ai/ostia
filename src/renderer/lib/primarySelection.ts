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
  let timer: ReturnType<typeof setTimeout> | null = null
  const selection = term.onSelectionChange(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (opts.enabled() && term.hasSelection()) opts.writePrimary(term.getSelection())
    }, PRIMARY_WRITE_DELAY_MS)
  })
  const blockMiddlePaste = (e: MouseEvent): void => {
    if (e.button === MIDDLE_BUTTON && !opts.enabled()) e.preventDefault()
  }
  host.addEventListener('mouseup', blockMiddlePaste, true)
  return () => {
    if (timer) clearTimeout(timer)
    selection.dispose()
    host.removeEventListener('mouseup', blockMiddlePaste, true)
  }
}
