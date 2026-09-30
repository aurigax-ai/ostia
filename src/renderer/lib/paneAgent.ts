import { type ResumableAgent, isResumableAgent } from '@shared/agentResume'
import { useBlocksStore } from '../stores/blocksStore'
import { commandAgent } from './hibernation'

export const FOREGROUND_CHECKS_MS = [800, 3000, 10_000] as const

export function runningAgentOf(paneId: string): ResumableAgent | null {
  const { running, byPane, agentBlocks } = useBlocksStore.getState()
  const blockId = running[paneId]
  if (!blockId) return null
  const command = byPane[paneId]?.find((b) => b.id === blockId)?.command
  const named = command ? commandAgent(command) : null
  if (named) return named
  const marked = agentBlocks[paneId]
  return marked?.blockId === blockId ? marked.agent : null
}

export function startAgentDetection(): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>()
  const cancel = (paneId: string): void => {
    for (const t of timers.get(paneId) ?? []) clearTimeout(t)
    timers.delete(paneId)
  }
  const check = async (paneId: string, blockId: string): Promise<void> => {
    if (useBlocksStore.getState().running[paneId] !== blockId) return
    const name = await window.pine.pty.foreground(paneId).catch(() => null)
    if (!isResumableAgent(name) || useBlocksStore.getState().running[paneId] !== blockId) return
    useBlocksStore.getState().markAgent(paneId, name)
    cancel(paneId)
  }
  const unsubscribe = useBlocksStore.subscribe((s, prev) => {
    if (s.running === prev.running) return
    for (const paneId of new Set([...Object.keys(s.running), ...Object.keys(prev.running)])) {
      const blockId = s.running[paneId]
      if (blockId === prev.running[paneId]) continue
      cancel(paneId)
      if (!blockId || runningAgentOf(paneId)) continue
      timers.set(
        paneId,
        FOREGROUND_CHECKS_MS.map((ms) => setTimeout(() => void check(paneId, blockId), ms)),
      )
    }
  })
  return () => {
    unsubscribe()
    for (const paneId of [...timers.keys()]) cancel(paneId)
  }
}
