import { useEffect, useRef } from 'react'
import { useSelectionSend } from '@/components/agents/SelectionSend'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { currentDict } from '@/lib/app/useDict'
import { selectedBlockOutput } from '@/lib/terminal/blockActions'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'

export function useTerminalSelectionSend({
  workspaceId,
  paneId,
  cwd,
  termRef,
}: {
  workspaceId: string
  paneId: string
  cwd: string | undefined
  termRef: { current: OstiaTerminal | null }
}): ReturnType<typeof useSelectionSend> {
  const selectionSend = useSelectionSend(workspaceId, paneId, true)
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () => {
    const selected = termRef.current?.getSelection() ?? ''
    const block = selected.trim() ? null : selectedBlockOutput(paneId)
    const text = block ? block.output : selected
    if (!text.trim()) {
      selectionSend.notify(currentDict().viewer.noTerminalSelection)
      return
    }
    selectionSend.open({
      kind: 'terminal',
      cwd: cwd ?? null,
      command: block?.command || null,
      text,
    })
  }

  useEffect(() => registerSelectionSender(paneId, () => sendSelectionRef.current()), [paneId])
  return selectionSend
}
