import { awaitsResume } from '@/lib/agents/autoResume'
import { allPanes } from '@/lib/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { startOffscreen } from './offscreenStart'

function startAll(waiting: ReadonlySet<string>): void {
  for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
    for (const pane of layout ? allPanes(layout.root) : []) {
      if (pane.kind !== 'terminal' || pane.hibernated || awaitsResume(pane)) continue
      startOffscreen(pane.id, waiting.has(pane.id) ? { keepSize: true } : {})
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
