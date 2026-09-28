import type { AgentResume } from '@shared/agentResume'
import type { DiffContent } from '@shared/extensions'
import { create } from 'zustand'
import {
  type DropZone,
  addTab,
  closePane,
  createPane,
  findExtensionPane,
  findPane,
  firstPaneId,
  firstPaneOfKind,
  movePane,
  paneIds,
  selectTab,
  setPaneBrowser,
  setPaneCwd,
  setPaneDiff,
  setPaneEditor,
  setPaneExtension,
  setPaneResume,
  setPaneTitle,
  setPaneUrl,
  setSizes,
  splitPane,
  tabsOfPane,
} from '../layout/tree'
import type { Direction, LayoutNode, PaneNode, SurfaceKind } from '../layout/types'
import { useDiffStore } from './diffStore'
import { useWorkspacesStore } from './workspacesStore'

export interface WorkspaceLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: string | null
}

interface LayoutState {
  byWorkspace: Record<string, WorkspaceLayout>
  ensure: (workspaceId: string) => void
  hydrate: (layouts: Record<string, WorkspaceLayout>) => void
  split: (workspaceId: string, paneId: string, direction: Direction) => void
  newTab: (workspaceId: string, paneId: string, kind: NewTabKind) => string | null
  closePane: (workspaceId: string, paneId: string) => void
  focusPane: (workspaceId: string, paneId: string) => void
  resize: (workspaceId: string, splitId: string, sizes: number[]) => void
  zoomPane: (workspaceId: string, paneId: string, zoom?: boolean) => void
  movePane: (workspaceId: string, sourceId: string, targetId: string, zone: DropZone) => void
  setCwd: (workspaceId: string, paneId: string, cwd: string) => void
  setUrl: (workspaceId: string, paneId: string, url: string) => void
  setResume: (workspaceId: string, paneId: string, resume: AgentResume) => void
  setTitle: (workspaceId: string, paneId: string, title: string) => void
  openFile: (workspaceId: string, path: string) => void
  openBrowser: (workspaceId: string, url: string) => void
  openExtensionPanel: (workspaceId: string, extensionId: string, title: string) => void
  openDiff: (workspaceId: string, content: DiffContent) => string | null
  removeWorkspace: (workspaceId: string) => void
}

export type NewTabKind = Extract<SurfaceKind, 'terminal' | 'browser'>

function layoutOf(root: LayoutNode): WorkspaceLayout {
  return { root, activePaneId: firstPaneId(root), zoomedPaneId: null }
}

function patch(
  state: LayoutState,
  workspaceId: string,
  fn: (layout: WorkspaceLayout) => WorkspaceLayout,
): Pick<LayoutState, 'byWorkspace'> | null {
  const layout = state.byWorkspace[workspaceId]
  if (!layout) return null
  const next = fn(layout)
  const root = selectTab(next.root, next.activePaneId)
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: root === next.root ? next : { ...next, root },
    },
  }
}

function seedLayout(workspaceId: string, make: (pane: PaneNode) => LayoutNode): string | null {
  if (useLayoutStore.getState().byWorkspace[workspaceId]) return null
  if (!useWorkspacesStore.getState().workspaces.some((w) => w.id === workspaceId)) return null
  const pane = createPane()
  useLayoutStore.setState((s) => ({
    byWorkspace: { ...s.byWorkspace, [workspaceId]: layoutOf(make(pane)) },
  }))
  window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: pane.id })
  return pane.id
}

function successorOf(before: LayoutNode, after: LayoutNode, closedId: string): string {
  const sibling = tabsOfPane(before, closedId)?.children.find((c) => c.id !== closedId)
  if (!sibling) return firstPaneId(after)
  return tabsOfPane(after, sibling.id)?.activeId ?? sibling.id
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  byWorkspace: {},

  ensure: (workspaceId) => {
    let createdPaneId: string | null = null
    set((s) => {
      if (s.byWorkspace[workspaceId]) return s
      const workDir = useWorkspacesStore
        .getState()
        .workspaces.find((sess) => sess.id === workspaceId)?.workDir
      const root = createPane('terminal', undefined, workDir)
      createdPaneId = firstPaneId(root)
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: layoutOf(root),
        },
      }
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
  },

  hydrate: (layouts) => {
    set({ byWorkspace: { ...layouts } })
    for (const [workspaceId, layout] of Object.entries(layouts)) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId })
      }
    }
  },

  split: (workspaceId, paneId, direction) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const result = splitPane(l.root, paneId, direction)
        createdPaneId = result.newPaneId
        return { ...l, root: result.root, activePaneId: result.newPaneId ?? l.activePaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
  },

  newTab: (workspaceId, paneId, kind) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const target = findPane(l.root, paneId)
        if (!target) return l
        const pane = createPane(kind, undefined, target.cwd)
        const root =
          kind === 'browser'
            ? setPaneBrowser(addTab(l.root, paneId, pane), pane.id, 'about:blank')
            : addTab(l.root, paneId, pane)
        createdPaneId = pane.id
        return { ...l, root, activePaneId: pane.id, zoomedPaneId: null }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
    return createdPaneId
  },

  closePane: (workspaceId, paneId) => {
    const current = get().byWorkspace[workspaceId]
    if (current?.root.type === 'pane' && current.root.id === paneId) {
      set((s) => {
        const { [workspaceId]: _emptied, ...byWorkspace } = s.byWorkspace
        return { byWorkspace }
      })
      window.pine?.lifecycle?.emit?.({ type: 'pane-closed', workspaceId, paneId })
      return
    }
    let removed = false
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const root = closePane(l.root, paneId)
        removed = findPane(l.root, paneId) !== null && findPane(root, paneId) === null
        const activePaneId =
          removed && paneId === l.activePaneId ? successorOf(l.root, root, paneId) : l.activePaneId
        const zoomedPaneId = removed && l.zoomedPaneId === paneId ? null : l.zoomedPaneId
        return { root, activePaneId, zoomedPaneId }
      })
      return next ?? s
    })
    if (removed) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-closed', workspaceId, paneId })
    }
  },

  focusPane: (workspaceId, paneId) =>
    set((s) => patch(s, workspaceId, (l) => ({ ...l, activePaneId: paneId })) ?? s),

  zoomPane: (workspaceId, paneId, zoom) =>
    set(
      (s) =>
        patch(s, workspaceId, (l) => {
          const zoomedPaneId =
            zoom === undefined
              ? l.zoomedPaneId === paneId
                ? null
                : paneId
              : zoom
                ? paneId
                : l.zoomedPaneId === paneId
                  ? null
                  : l.zoomedPaneId
          return { ...l, zoomedPaneId }
        }) ?? s,
    ),

  resize: (workspaceId, splitId, sizes) =>
    set(
      (s) => patch(s, workspaceId, (l) => ({ ...l, root: setSizes(l.root, splitId, sizes) })) ?? s,
    ),

  movePane: (workspaceId, sourceId, targetId, zone) =>
    set(
      (s) =>
        patch(s, workspaceId, (l) => ({
          ...l,
          root: movePane(l.root, sourceId, targetId, zone),
          activePaneId: sourceId,
        })) ?? s,
    ),

  setCwd: (workspaceId, paneId, cwd) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setPaneCwd(layout.root, paneId, cwd)
      return root === layout.root
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
    }),

  setUrl: (workspaceId, paneId, url) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setPaneUrl(layout.root, paneId, url)
      return root === layout.root
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
    }),

  setTitle: (workspaceId, paneId, title) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setPaneTitle(layout.root, paneId, title)
      return root === layout.root
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
    }),

  setResume: (workspaceId, paneId, resume) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setPaneResume(layout.root, paneId, resume)
      return root === layout.root
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
    }),

  openFile: (workspaceId, path) => {
    const title = path.split('/').pop() || path
    if (seedLayout(workspaceId, (p) => setPaneEditor(p, p.id, title, path))) return
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const existing = firstPaneOfKind(l.root, 'editor')
        if (existing) {
          return {
            ...l,
            root: setPaneEditor(l.root, existing.id, title, path),
            activePaneId: existing.id,
          }
        }
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return { ...l, root: setPaneEditor(root, newPaneId, title, path), activePaneId: newPaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
  },

  openBrowser: (workspaceId, url) => {
    if (seedLayout(workspaceId, (p) => setPaneBrowser(p, p.id, url))) return
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const existing = firstPaneOfKind(l.root, 'browser')
        if (existing) {
          return {
            ...l,
            root: setPaneBrowser(l.root, existing.id, url),
            activePaneId: existing.id,
          }
        }
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return { ...l, root: setPaneBrowser(root, newPaneId, url), activePaneId: newPaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
  },

  openExtensionPanel: (workspaceId, extensionId, title) => {
    if (seedLayout(workspaceId, (p) => setPaneExtension(p, p.id, extensionId, title))) return
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const existing = findExtensionPane(l.root, extensionId)
        if (existing) return { ...l, activePaneId: existing.id }
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return {
          ...l,
          root: setPaneExtension(root, newPaneId, extensionId, title),
          activePaneId: newPaneId,
        }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
  },

  openDiff: (workspaceId, content) => {
    let createdPaneId: string | null = null
    let diffPaneId: string | null = null
    const slash = content.path ? content.path.lastIndexOf('/') : -1
    const cwd = content.path && slash > 0 ? content.path.slice(0, slash) : undefined
    const seeded = seedLayout(workspaceId, (p) => setPaneDiff(p, p.id, content.title, cwd))
    if (seeded) {
      useDiffStore.getState().set(seeded, content)
      return seeded
    }
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const existing = firstPaneOfKind(l.root, 'diff')
        if (existing) {
          diffPaneId = existing.id
          return {
            ...l,
            root: setPaneDiff(l.root, existing.id, content.title, cwd),
            activePaneId: existing.id,
          }
        }
        const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        diffPaneId = newPaneId
        return {
          ...l,
          root: setPaneDiff(root, newPaneId, content.title, cwd),
          activePaneId: newPaneId,
        }
      })
      return next ?? s
    })
    if (diffPaneId) useDiffStore.getState().set(diffPaneId, content)
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
    return diffPaneId
  },

  removeWorkspace: (workspaceId) => {
    const layout = get().byWorkspace[workspaceId]
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s
      const { [workspaceId]: _removed, ...byWorkspace } = s.byWorkspace
      return { byWorkspace }
    })
    if (layout) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-closed', workspaceId, paneId })
      }
    }
  },
}))
