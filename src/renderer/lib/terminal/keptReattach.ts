import { allPanes } from '@/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { startOffscreen } from './offscreenStart'

export function startKeptReattach(): void {
  void window.ostia.pty
    .keptWaiting()
    .then((paneIds) => {
      const waiting = new Set(paneIds)
      for (const layout of Object.values(useLayoutStore.getState().byWorkspace)) {
        for (const pane of layout ? allPanes(layout.root) : []) {
          if (pane.kind === 'terminal' && !pane.hibernated && waiting.has(pane.id)) {
            startOffscreen(pane.id, { keepSize: true })
          }
        }
      }
    })
    .catch(() => undefined)
}
