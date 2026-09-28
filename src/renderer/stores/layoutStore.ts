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
  setPaneUrl,
  setSizes,
  splitPane,
  tabsOfPane,
} from '../layout/tree'
import type { Direction, LayoutNode, SurfaceKind } from '../layout/types'
import { useDiffStore } from './diffStore'
import { useSessionsStore } from './sessionsStore'

export interface SessionLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: string | null
}

interface LayoutState {
  bySession: Record<string, SessionLayout>
  ensure: (sessionId: string) => void
  hydrate: (layouts: Record<string, SessionLayout>) => void
  split: (sessionId: string, paneId: string, direction: Direction) => void
  newTab: (sessionId: string, paneId: string, kind: NewTabKind) => string | null
  closePane: (sessionId: string, paneId: string) => void
  focusPane: (sessionId: string, paneId: string) => void
  resize: (sessionId: string, splitId: string, sizes: number[]) => void
  zoomPane: (sessionId: string, paneId: string, zoom?: boolean) => void
  movePane: (sessionId: string, sourceId: string, targetId: string, zone: DropZone) => void
  setCwd: (sessionId: string, paneId: string, cwd: string) => void
  setUrl: (sessionId: string, paneId: string, url: string) => void
  setResume: (sessionId: string, paneId: string, resume: AgentResume) => void
  openFile: (sessionId: string, path: string) => void
  openBrowser: (sessionId: string, url: string) => void
  openExtensionPanel: (sessionId: string, extensionId: string, title: string) => void
  openDiff: (sessionId: string, content: DiffContent) => string | null
  removeSession: (sessionId: string) => void
}

export type NewTabKind = Extract<SurfaceKind, 'terminal' | 'browser'>

function layoutOf(root: LayoutNode): SessionLayout {
  return { root, activePaneId: firstPaneId(root), zoomedPaneId: null }
}

function patch(
  state: LayoutState,
  sessionId: string,
  fn: (layout: SessionLayout) => SessionLayout,
): Pick<LayoutState, 'bySession'> | null {
  const layout = state.bySession[sessionId]
  if (!layout) return null
  const next = fn(layout)
  const root = selectTab(next.root, next.activePaneId)
  return {
    bySession: { ...state.bySession, [sessionId]: root === next.root ? next : { ...next, root } },
  }
}

function successorOf(before: LayoutNode, after: LayoutNode, closedId: string): string {
  const sibling = tabsOfPane(before, closedId)?.children.find((c) => c.id !== closedId)
  if (!sibling) return firstPaneId(after)
  return tabsOfPane(after, sibling.id)?.activeId ?? sibling.id
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  bySession: {},

  ensure: (sessionId) => {
    let createdPaneId: string | null = null
    set((s) => {
      if (s.bySession[sessionId]) return s
      const workDir = useSessionsStore
        .getState()
        .sessions.find((sess) => sess.id === sessionId)?.workDir
      const root = createPane('terminal', undefined, workDir)
      createdPaneId = firstPaneId(root)
      return {
        bySession: {
          ...s.bySession,
          [sessionId]: layoutOf(root),
        },
      }
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  hydrate: (layouts) => {
    set({ bySession: { ...layouts } })
    for (const [sessionId, layout] of Object.entries(layouts)) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId })
      }
    }
  },

  split: (sessionId, paneId, direction) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        const result = splitPane(l.root, paneId, direction)
        createdPaneId = result.newPaneId
        return { ...l, root: result.root, activePaneId: result.newPaneId ?? l.activePaneId }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  newTab: (sessionId, paneId, kind) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
    return createdPaneId
  },

  closePane: (sessionId, paneId) => {
    let removed = false
    set((s) => {
      const next = patch(s, sessionId, (l) => {
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-closed', sessionId, paneId })
    }
  },

  focusPane: (sessionId, paneId) =>
    set((s) => patch(s, sessionId, (l) => ({ ...l, activePaneId: paneId })) ?? s),

  zoomPane: (sessionId, paneId, zoom) =>
    set(
      (s) =>
        patch(s, sessionId, (l) => {
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

  resize: (sessionId, splitId, sizes) =>
    set((s) => patch(s, sessionId, (l) => ({ ...l, root: setSizes(l.root, splitId, sizes) })) ?? s),

  movePane: (sessionId, sourceId, targetId, zone) =>
    set(
      (s) =>
        patch(s, sessionId, (l) => ({
          ...l,
          root: movePane(l.root, sourceId, targetId, zone),
          activePaneId: sourceId,
        })) ?? s,
    ),

  setCwd: (sessionId, paneId, cwd) =>
    set((s) => {
      const layout = s.bySession[sessionId]
      if (!layout) return s
      const root = setPaneCwd(layout.root, paneId, cwd)
      return root === layout.root
        ? s
        : { bySession: { ...s.bySession, [sessionId]: { ...layout, root } } }
    }),

  setUrl: (sessionId, paneId, url) =>
    set((s) => {
      const layout = s.bySession[sessionId]
      if (!layout) return s
      const root = setPaneUrl(layout.root, paneId, url)
      return root === layout.root
        ? s
        : { bySession: { ...s.bySession, [sessionId]: { ...layout, root } } }
    }),

  setResume: (sessionId, paneId, resume) =>
    set((s) => {
      const layout = s.bySession[sessionId]
      if (!layout) return s
      const root = setPaneResume(layout.root, paneId, resume)
      return root === layout.root
        ? s
        : { bySession: { ...s.bySession, [sessionId]: { ...layout, root } } }
    }),

  openFile: (sessionId, path) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
        const title = path.split('/').pop() || path
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  openBrowser: (sessionId, url) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  openExtensionPanel: (sessionId, extensionId, title) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, sessionId, (l) => {
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
  },

  openDiff: (sessionId, content) => {
    let createdPaneId: string | null = null
    let diffPaneId: string | null = null
    const slash = content.path ? content.path.lastIndexOf('/') : -1
    const cwd = content.path && slash > 0 ? content.path.slice(0, slash) : undefined
    set((s) => {
      const next = patch(s, sessionId, (l) => {
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
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', sessionId, paneId: createdPaneId })
    }
    return diffPaneId
  },

  removeSession: (sessionId) => {
    const layout = get().bySession[sessionId]
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const { [sessionId]: _removed, ...bySession } = s.bySession
      return { bySession }
    })
    if (layout) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-closed', sessionId, paneId })
      }
    }
  },
}))
