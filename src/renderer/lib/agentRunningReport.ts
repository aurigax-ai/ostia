import type { ResumableAgent } from '@shared/agentResume'
import { allPanes } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { runningAgentOf } from './paneAgent'

export function paneAgentRunning(paneId: string, agent: ResumableAgent): boolean | null {
  if (runningAgentOf(paneId) === agent) return true
  const { running, byPane } = useBlocksStore.getState()
  if (running[paneId] !== undefined) return false
  return (byPane[paneId]?.length ?? 0) > 0 ? false : null
}

export function startAgentRunningReport(): () => void {
  const reported = new Map<string, boolean>()

  const sweep = (): void => {
    for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
      for (const pane of layout ? allPanes(layout.root) : []) {
        if (!pane.resume) continue
        const running = paneAgentRunning(pane.id, pane.resume.agent)
        if (running === null) reported.delete(pane.id)
        if (running === null || reported.get(pane.id) === running) continue
        reported.set(pane.id, running)
        window.pine.pty.reportAgentRunning(pane.id, running)
      }
    }
  }

  sweep()
  const unsubscribe = [
    useLayoutStore.subscribe(sweep),
    useBlocksStore.subscribe((s, prev) => {
      if (
        s.running !== prev.running ||
        s.byPane !== prev.byPane ||
        s.agentBlocks !== prev.agentBlocks
      )
        sweep()
    }),
  ]
  return () => {
    for (const off of unsubscribe) off()
  }
}
