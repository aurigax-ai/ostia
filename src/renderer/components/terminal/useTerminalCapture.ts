import { type RefObject, useEffect, useRef } from 'react'
import { currentDict } from '@/lib/app/useDict'
import { openCapture, registerCaptureOpener, setCaptureStatus } from '@/lib/capture/captureSession'
import { selectionAdapter } from '@/lib/capture/selectionAdapter'
import { selectedBlockOutput } from '@/lib/terminal/blockActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { terminalSelectionAnchor } from '@/lib/terminal/selectionAnchor'

export function useTerminalCapture({
  paneId,
  cwd,
  termRef,
  surfaceRef,
}: {
  paneId: string
  cwd: string | undefined
  termRef: { current: OstiaTerminal | null }
  surfaceRef: RefObject<HTMLElement | null>
}): void {
  const openRef = useRef<() => void>(() => {})
  openRef.current = () => {
    const term = termRef.current
    const selected = term?.getSelection() ?? ''
    const block = selected.trim() ? null : selectedBlockOutput(paneId)
    const text = block ? block.output : selected
    if (!text.trim()) {
      setCaptureStatus(paneId, currentDict().viewer.noTerminalSelection)
      return
    }
    const surface = surfaceRef.current
    openCapture(
      paneId,
      selectionAdapter({
        paneId,
        capture: { kind: 'terminal', cwd: cwd ?? null, command: block?.command || null, text },
        anchor: !block && term && surface ? terminalSelectionAnchor(term, surface) : null,
      }),
    )
  }

  useEffect(() => registerCaptureOpener(paneId, () => openRef.current()), [paneId])
}
