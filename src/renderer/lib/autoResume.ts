import { resumeCommand } from '@shared/agentResume'
import { allPanes } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { runWhenIdle } from './blockActions'
import { isPaneVisible } from './workspaceActivity'

interface PendingPane {
  workspaceId: string
  pane: PaneNode
}

function pendingPanes(): PendingPane[] {
  const out: PendingPane[] = []
  for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (pane.resumePending && pane.resume) out.push({ workspaceId, pane })
    }
  }
  return out
}

function clear(workspaceId: string, paneId: string): void {
  useLayoutStore.getState().setResumePending(workspaceId, paneId, false)
}

export function startAutoResume(): () => void {
  const scheduled = new Map<string, () => void>()

  const sweep = (): void => {
    const enabled = useSettingsStore.getState().agents.autoResume
    const running = useBlocksStore.getState().running
    for (const { workspaceId, pane } of pendingPanes()) {
      const resume = pane.resume
      if (!resume) continue
      if (!enabled || running[pane.id] !== undefined || pane.kind !== 'terminal') {
        scheduled.get(pane.id)?.()
        scheduled.delete(pane.id)
        clear(workspaceId, pane.id)
        continue
      }
      if (scheduled.has(pane.id) || !isPaneVisible(pane.id)) continue
      const cancel = runWhenIdle(pane.id, resumeCommand(resume))
      scheduled.set(pane.id, cancel)
      clear(workspaceId, pane.id)
    }
  }

  sweep()
  const unsubscribe = [
    useLayoutStore.subscribe(sweep),
    useWorkspacesStore.subscribe(sweep),
    useUIStore.subscribe(sweep),
    useSettingsStore.subscribe(sweep),
    useBlocksStore.subscribe((s, prev) => {
      if (s.running !== prev.running) sweep()
    }),
  ]
  return () => {
    for (const off of unsubscribe) off()
    for (const cancel of scheduled.values()) cancel()
    scheduled.clear()
  }
}
