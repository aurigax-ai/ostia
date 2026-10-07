import { allPanes } from '../layout/tree'
import type { LayoutNode, PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { wakePane } from './hibernationScheduler'
import { resumeWhenIdle } from './resumeFolder'

interface PendingPane {
  workspaceId: string
  pane: PaneNode
}

function awaitsResume(pane: PaneNode): boolean {
  return Boolean(pane.resumePending && pane.resume && !pane.hibernated)
}

export function workspacesAwaitingResume(
  byWorkspace: Record<string, { root: LayoutNode } | undefined>,
): string[] {
  return Object.entries(byWorkspace)
    .filter(([, layout]) => layout && allPanes(layout.root).some(awaitsResume))
    .map(([workspaceId]) => workspaceId)
}

function pendingPanes(): PendingPane[] {
  const out: PendingPane[] = []
  for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (awaitsResume(pane)) out.push({ workspaceId, pane })
    }
  }
  return out
}

function clear(workspaceId: string, paneId: string): void {
  useLayoutStore.getState().setResumePending(workspaceId, paneId, false)
}

const activated = new Set<string>()
let sweepNow: (() => void) | null = null

export function resumeOnActivation(paneId: string): void {
  if (wakePane(paneId)) return
  if (!pendingPanes().some(({ pane }) => pane.id === paneId)) return
  activated.add(paneId)
  sweepNow?.()
}

export function startAutoResume(): () => void {
  const scheduled = new Map<string, () => void>()

  const sweep = (): void => {
    const enabled = useSettingsStore.getState().agents.autoResume
    const running = useBlocksStore.getState().running
    const panes = pendingPanes()
    const waiting = new Set(panes.map(({ pane }) => pane.id))
    for (const [paneId, cancel] of [...scheduled]) {
      if (waiting.has(paneId)) continue
      cancel()
      scheduled.delete(paneId)
    }
    for (const paneId of [...activated]) {
      if (!waiting.has(paneId)) activated.delete(paneId)
    }
    for (const { workspaceId, pane } of panes) {
      const resume = pane.resume
      if (!resume) continue
      if (running[pane.id] !== undefined || pane.kind !== 'terminal' || pane.resumeFolderMissing) {
        scheduled.get(pane.id)?.()
        scheduled.delete(pane.id)
        activated.delete(pane.id)
        clear(workspaceId, pane.id)
        continue
      }
      if (!enabled && !activated.has(pane.id)) {
        scheduled.get(pane.id)?.()
        scheduled.delete(pane.id)
        continue
      }
      if (scheduled.has(pane.id)) continue
      scheduled.set(pane.id, resumeWhenIdle(pane.id, resume))
    }
  }

  sweepNow = sweep
  sweep()
  const unsubscribe = [
    useLayoutStore.subscribe(sweep),
    useSettingsStore.subscribe(sweep),
    useBlocksStore.subscribe((s, prev) => {
      if (s.running !== prev.running) sweep()
    }),
  ]
  return () => {
    sweepNow = null
    activated.clear()
    for (const off of unsubscribe) off()
    for (const cancel of scheduled.values()) cancel()
    scheduled.clear()
  }
}

export function keptShellReattached(workspaceId: string, paneId: string): void {
  clear(workspaceId, paneId)
}
