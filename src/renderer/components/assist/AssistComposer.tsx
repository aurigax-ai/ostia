import { type JSX, type RefObject, useEffect, useState } from 'react'
import { composerModeOf } from '@/commands/assistCompose'
import type { ComposerMode } from '@/lib/assist/assistComposer'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { useAssistComposerStore } from '@/stores/assist/assistComposerStore'
import { AgentPromptComposer } from './AgentPromptComposer'
import { ShellComposer } from './ShellComposer'

export function AssistComposer({
  paneId,
  cwd,
  termRef,
}: {
  paneId: string
  cwd?: string
  termRef: RefObject<Xterm | null>
}): JSX.Element | null {
  const openPane = useAssistComposerStore((s) => s.paneId)
  const [mode, setMode] = useState<ComposerMode | null>(null)
  const open = openPane === paneId

  useEffect(() => {
    if (!open) {
      setMode(null)
      return
    }
    const next = composerModeOf(paneId)
    if (next) setMode(next)
    else useAssistComposerStore.getState().close()
  }, [open, paneId])

  if (!open || !mode) return null
  const close = (): void => {
    useAssistComposerStore.getState().close()
    termRef.current?.focus()
  }
  return mode === 'agent' ? (
    <AgentPromptComposer paneId={paneId} onClose={close} />
  ) : (
    <ShellComposer paneId={paneId} cwd={cwd} onClose={close} />
  )
}
