import { awaitsResume } from '@/lib/agents/autoResume'
import { allPanes } from '@/lib/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { startOffscreen } from './offscreenStart'

let kept: ReadonlySet<string> = new Set()

export function isKeptShell(paneId: string): boolean {
  return kept.has(paneId)
}

function startAll(waiting: ReadonlySet<string>): void {
  kept = waiting
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (pane.kind !== 'terminal' || pane.hibernated) continue
      if (waiting.has(pane.id)) startOffscreen(pane.id, { keepSize: true })
      else if (!awaitsResume(pane)) startOffscreen(pane.id, {})
    }
  }
}

export function startKeptReattach(): void {
  void window.ostia.pty
    .keptWaiting()
    .then((paneIds) => new Set(paneIds))
    .catch(() => new Set<string>())
    .then(startAll)
}
