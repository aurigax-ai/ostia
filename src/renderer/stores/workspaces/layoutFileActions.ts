import { baseName } from '@/lib/files/fileTree'
import { setPaneEditor } from '@/lib/layout/paneFields'
import {
  addTab,
  allPanes,
  createPane,
  findPane,
  slotPaneOfKind,
  splitBeside,
} from '@/lib/layout/tree'
import { patch } from '@/lib/panes/layoutPatch'
import { noteOpener } from '@/lib/panes/tabHistory'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { isWaitedPane } from '@/stores/files/openWaitsStore'
import { seedLayout } from './layoutSeed'
import type { LayoutGet, LayoutSet, LayoutState } from './layoutTypes'

type LayoutFileActions = Pick<LayoutState, 'openFile' | 'openFileTab' | 'openFileBeside'>

export function createLayoutFileActions(set: LayoutSet, get: LayoutGet): LayoutFileActions {
  return {
    openFile: (workspaceId, path) => {
      const title = baseName(path)
      if (seedLayout(set, get, workspaceId, (p) => setPaneEditor(p, p.id, title, path))) return
      let createdPaneId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const inTab = useSettingsStore.getState().editor.openFilesIn === 'tab'
          const showing = allPanes(l.root).find((p) => p.kind === 'editor' && p.filePath === path)
          if (inTab && showing) return { ...l, activePaneId: showing.id }
          const reusable = inTab
            ? slotPaneOfKind(l.root, l.activePaneId, 'editor')
            : (allPanes(l.root).find((p) => p.kind === 'editor' && !isWaitedPane(p.id)) ?? null)
          const existing = reusable && !isWaitedPane(reusable.id) ? reusable : null
          if (existing) {
            return {
              ...l,
              root: setPaneEditor(l.root, existing.id, title, path),
              activePaneId: existing.id,
            }
          }
          if (inTab) {
            const pane = createPane('editor')
            createdPaneId = pane.id
            return {
              ...l,
              root: setPaneEditor(addTab(l.root, l.activePaneId, pane), pane.id, title, path),
              activePaneId: pane.id,
            }
          }
          const { root, newPaneId } = splitBeside(l.root, l.activePaneId, 'horizontal')
          if (!newPaneId) return l
          createdPaneId = newPaneId
          return {
            ...l,
            root: setPaneEditor(root, newPaneId, title, path),
            activePaneId: newPaneId,
          }
        })
        return next ?? s
      })
      if (createdPaneId) {
        window.ostia?.lifecycle?.emit?.({
          type: 'pane-created',
          workspaceId,
          paneId: createdPaneId,
        })
      }
    },

    openFileTab: (workspaceId, path, paneId, background = false, fresh = false) => {
      const title = baseName(path)
      const seeded = seedLayout(set, get, workspaceId, (p) => setPaneEditor(p, p.id, title, path))
      if (seeded) return seeded
      let createdPaneId: string | null = null
      let openerId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const showing = fresh
            ? undefined
            : allPanes(l.root).find((p) => p.kind === 'editor' && p.filePath === path)
          if (showing) return background ? l : { ...l, activePaneId: showing.id }
          const target = paneId && findPane(l.root, paneId) ? paneId : l.activePaneId
          const pane = createPane('editor')
          createdPaneId = pane.id
          openerId = target
          const root = setPaneEditor(addTab(l.root, target, pane, background), pane.id, title, path)
          return background ? { ...l, root } : { ...l, root, activePaneId: pane.id }
        })
        return next ?? s
      })
      if (createdPaneId && openerId) noteOpener(workspaceId, createdPaneId, openerId)
      if (createdPaneId) {
        window.ostia?.lifecycle?.emit?.({
          type: 'pane-created',
          workspaceId,
          paneId: createdPaneId,
        })
      }
      return createdPaneId
    },

    openFileBeside: (workspaceId, path) => {
      const title = baseName(path)
      if (seedLayout(set, get, workspaceId, (p) => setPaneEditor(p, p.id, title, path))) return
      let createdPaneId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const { root, newPaneId } = splitBeside(l.root, l.activePaneId, 'horizontal')
          if (!newPaneId) return l
          createdPaneId = newPaneId
          return {
            ...l,
            root: setPaneEditor(root, newPaneId, title, path),
            activePaneId: newPaneId,
          }
        })
        return next ?? s
      })
      if (createdPaneId) {
        window.ostia?.lifecycle?.emit?.({
          type: 'pane-created',
          workspaceId,
          paneId: createdPaneId,
        })
      }
    },
  }
}
