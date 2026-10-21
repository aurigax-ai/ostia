import type { ResumableAgent } from '@shared/agents/agentResume'
import { countUsage } from '@/lib/app/usageCounts'
import { allPanes } from '@/lib/layout/tree'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { runningAgentOf } from './paneAgent'

function paneAgentRunning(paneId: string, agent: ResumableAgent): boolean | null {
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
        if (!pane.resume) {
          if (pane.resumeFailed && reported.get(pane.id) !== false) {
            reported.set(pane.id, false)
            window.ostia.pty.reportAgentRunning(pane.id, false)
          }
          continue
        }
        const running = paneAgentRunning(pane.id, pane.resume.agent)
        if (running === null) reported.delete(pane.id)
        if (running === null || reported.get(pane.id) === running) continue
        reported.set(pane.id, running)
        if (running) countUsage('agents', 'session', pane.resume.agent)
        window.ostia.pty.reportAgentRunning(pane.id, running)
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
