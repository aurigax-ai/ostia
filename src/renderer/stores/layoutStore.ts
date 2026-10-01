import type { AgentResume } from '@shared/agentResume'
import type { DiffContent } from '@shared/extensions'
import type { PanePlacement } from '@shared/types'
import { create } from 'zustand'
import { panelKey, sizePanel } from '../layout/panelSize'
import {
  type DropZone,
  addTab,
  allPanes,
  closePane,
  createPane,
  equalizeSizes,
  findExtensionPane,
  findPane,
  findViewPane,
  firstPaneId,
  firstPaneOfKind,
  graftNode,
  mergeLayouts,
  movePane,
  moveTab,
  paneIds,
  selectTab,
  setPaneBrowser,
  setPaneChat,
  setPaneCwd,
  setPaneDiff,
  setPaneEditor,
  setPaneExtension,
  setPaneHibernated,
  setPaneResume,
  setPaneTitle,
  setPaneUrl,
  setPaneView,
  setResumePending,
  setSizes,
  slotCount,
  slotPaneOfKind,
  splitPane,
  tabsOfPane,
} from '../layout/tree'
import type { Direction, LayoutNode, PaneNode, SurfaceKind } from '../layout/types'
import { rememberedPanelFraction } from '../lib/panelSizes'
import { useDiffStore } from './diffStore'
import { useSettingsStore } from './settingsStore'
import { useWorkspacesStore } from './workspacesStore'

export interface WorkspaceLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: string | null
  equalized?: number
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
  moveTab: (workspaceId: string, sourceId: string, targetId: string, after: boolean) => void
  setCwd: (workspaceId: string, paneId: string, cwd: string) => void
  setUrl: (workspaceId: string, paneId: string, url: string) => void
  setResume: (workspaceId: string, paneId: string, resume: AgentResume) => void
  setResumePending: (workspaceId: string, paneId: string, pending: boolean) => void
  setHibernated: (workspaceId: string, paneId: string, hibernated: boolean) => void
  setTitle: (workspaceId: string, paneId: string, title: string) => void
  openFile: (workspaceId: string, path: string) => void
  openFileBeside: (workspaceId: string, path: string) => void
  openTerminalTab: (workspaceId: string, cwd: string) => string | null
  openBrowser: (workspaceId: string, url: string) => void
  openExtensionPanel: (workspaceId: string, extensionId: string, title: string) => string | null
  openView: (workspaceId: string, viewName: string, title: string) => string | null
  openDiff: (workspaceId: string, content: DiffContent) => string | null
  openChat: (workspaceId: string, title: string) => string | null
  setChatSession: (workspaceId: string, paneId: string, sessionId: string, title: string) => void
  openTerminal: (workspaceId: string, opts: OpenTerminalPlacement) => string | null
  openManager: (workspaceId: string, opts: { cwd: string; title: string }) => string | null
  removeWorkspace: (workspaceId: string) => void
  release: (workspaceId: string) => void
  releasePane: (workspaceId: string, paneId: string) => void
  merge: (sourceId: string, targetId: string) => void
  adopt: (layouts: Record<string, WorkspaceLayout>) => void
  graft: (workspaceId: string, layout: WorkspaceLayout, beside?: PanePlacement) => void
}

export interface OpenTerminalPlacement {
  afterPaneId?: string
  cwd?: string
  title?: string
}

function describeTerminal(root: LayoutNode, paneId: string, opts: OpenTerminalPlacement) {
  const withCwd = opts.cwd ? setPaneCwd(root, paneId, opts.cwd) : root
  return opts.title ? setPaneTitle(withCwd, paneId, opts.title) : withCwd
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
  const selected = selectTab(next.root, next.activePaneId)
  const created = slotCount(selected) > slotCount(layout.root)
  const equalize = created && useSettingsStore.getState().panes.equalizeOnSplit
  const root = equalize ? equalizeSizes(selected) : selected
  const equalized = equalize ? (next.equalized ?? layout.equalized ?? 0) + 1 : undefined
  const carried = equalized ?? next.equalized ?? layout.equalized
  const result: WorkspaceLayout = { ...next, root }
  if (carried !== undefined) result.equalized = carried
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: root === next.root && carried === next.equalized ? next : result,
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

function withRememberedPanelSize(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const pane = findPane(layout.root, paneId)
  const key = pane ? panelKey(pane) : null
  const fraction = key ? rememberedPanelFraction(key) : null
  if (fraction === null) return layout
  const root = sizePanel(layout.root, paneId, fraction)
  return root === layout.root ? layout : { ...layout, root }
}

function openSingleton(
  workspaceId: string,
  find: (root: LayoutNode) => PaneNode | null,
  apply: (root: LayoutNode, paneId: string) => LayoutNode,
): string | null {
  const seeded = seedLayout(workspaceId, (p) => apply(p, p.id))
  if (seeded) return seeded
  let createdPaneId: string | null = null
  let targetPaneId: string | null = null
  useLayoutStore.setState((s) => {
    const next = patch(s, workspaceId, (l) => {
      const existing = find(l.root)
      if (existing) {
        targetPaneId = existing.id
        return { ...l, activePaneId: existing.id }
      }
      const { root, newPaneId } = splitPane(l.root, l.activePaneId, 'horizontal')
      if (!newPaneId) return l
      createdPaneId = newPaneId
      targetPaneId = newPaneId
      return { ...l, root: apply(root, newPaneId), activePaneId: newPaneId }
    })
    if (!next) return s
    if (!createdPaneId) return next
    const created = next.byWorkspace[workspaceId]
    const sized = withRememberedPanelSize(created, createdPaneId)
    return sized === created ? next : { byWorkspace: { ...next.byWorkspace, [workspaceId]: sized } }
  })
  if (createdPaneId) {
    window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
  }
  return targetPaneId
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

  moveTab: (workspaceId, sourceId, targetId, after) =>
    set(
      (s) =>
        patch(s, workspaceId, (l) => ({
          ...l,
          root: moveTab(l.root, sourceId, targetId, after),
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

  setResumePending: (workspaceId, paneId, pending) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setResumePending(layout.root, paneId, pending)
      return root === layout.root
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...layout, root } } }
    }),

  setHibernated: (workspaceId, paneId, hibernated) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      if (!layout) return s
      const root = setPaneHibernated(layout.root, paneId, hibernated)
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
        const inTab = useSettingsStore.getState().editor.openFilesIn === 'tab'
        const showing = allPanes(l.root).find((p) => p.kind === 'editor' && p.filePath === path)
        if (inTab && showing) return { ...l, activePaneId: showing.id }
        const existing = inTab
          ? slotPaneOfKind(l.root, l.activePaneId, 'editor')
          : firstPaneOfKind(l.root, 'editor')
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

  openFileBeside: (workspaceId, path) => {
    const title = path.split('/').pop() || path
    if (seedLayout(workspaceId, (p) => setPaneEditor(p, p.id, title, path))) return
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
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

  openTerminalTab: (workspaceId, cwd) => {
    const layout = get().byWorkspace[workspaceId]
    if (!layout) return get().openTerminal(workspaceId, { cwd })
    const paneId = get().newTab(workspaceId, layout.activePaneId, 'terminal')
    if (paneId) get().setCwd(workspaceId, paneId, cwd)
    return paneId
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

  openExtensionPanel: (workspaceId, extensionId, title) =>
    openSingleton(
      workspaceId,
      (root) => findExtensionPane(root, extensionId),
      (root, paneId) => setPaneExtension(root, paneId, extensionId, title),
    ),

  openView: (workspaceId, viewName, title) =>
    openSingleton(
      workspaceId,
      (root) => findViewPane(root, viewName),
      (root, paneId) => setPaneView(root, paneId, viewName, title),
    ),

  openChat: (workspaceId, title) =>
    openSingleton(
      workspaceId,
      (root) => firstPaneOfKind(root, 'chat'),
      (root, paneId) => setPaneChat(root, paneId, title),
    ),

  setChatSession: (workspaceId, paneId, sessionId, title) =>
    set((s) => {
      const layout = s.byWorkspace[workspaceId]
      const pane = layout ? findPane(layout.root, paneId) : null
      if (!layout || pane?.kind !== 'chat') return s
      if (pane.chatSessionId === sessionId && pane.title === title) return s
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: { ...layout, root: setPaneChat(layout.root, paneId, title, sessionId) },
        },
      }
    }),

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

  openManager: (workspaceId, opts) =>
    seedLayout(workspaceId, (p) => ({ ...p, kind: 'manager', cwd: opts.cwd, title: opts.title })),

  openTerminal: (workspaceId, opts) => {
    const seeded = seedLayout(workspaceId, (p) => describeTerminal(p, p.id, opts))
    if (seeded) return seeded
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const beside =
          opts.afterPaneId && findPane(l.root, opts.afterPaneId) ? opts.afterPaneId : l.activePaneId
        const { root, newPaneId } = splitPane(l.root, beside, 'horizontal')
        if (!newPaneId) return l
        createdPaneId = newPaneId
        return {
          root: describeTerminal(root, newPaneId, opts),
          activePaneId: newPaneId,
          zoomedPaneId: null,
        }
      })
      return next ?? s
    })
    if (createdPaneId) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
    }
    return createdPaneId
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

  release: (workspaceId) =>
    set((s) => {
      if (!(workspaceId in s.byWorkspace)) return s
      const { [workspaceId]: _released, ...byWorkspace } = s.byWorkspace
      return { byWorkspace }
    }),

  releasePane: (workspaceId, paneId) => {
    const current = get().byWorkspace[workspaceId]
    if (!current || !findPane(current.root, paneId)) return
    if (current.root.type === 'pane') {
      get().release(workspaceId)
      return
    }
    set(
      (s) =>
        patch(s, workspaceId, (l) => {
          const root = closePane(l.root, paneId)
          const activePaneId =
            paneId === l.activePaneId ? successorOf(l.root, root, paneId) : l.activePaneId
          return {
            root,
            activePaneId,
            zoomedPaneId: l.zoomedPaneId === paneId ? null : l.zoomedPaneId,
          }
        }) ?? s,
    )
  },

  graft: (workspaceId, incoming, beside) => {
    set((s) => {
      if (!s.byWorkspace[workspaceId]) {
        return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...incoming } } }
      }
      return (
        patch(s, workspaceId, (l) => ({
          ...l,
          root: graftNode(l.root, incoming.root, beside),
          activePaneId: incoming.activePaneId,
          zoomedPaneId: null,
        })) ?? s
      )
    })
    for (const paneId of paneIds(incoming.root)) {
      window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId })
    }
  },
  merge: (sourceId, targetId) =>
    set((s) => {
      const source = s.byWorkspace[sourceId]
      if (sourceId === targetId || !source) return s
      const { [sourceId]: _moved, ...byWorkspace } = s.byWorkspace
      if (!byWorkspace[targetId]) return { byWorkspace: { ...byWorkspace, [targetId]: source } }
      return (
        patch({ ...s, byWorkspace }, targetId, (l) => ({
          ...l,
          root: mergeLayouts(l.root, source.root),
          activePaneId: source.activePaneId,
          zoomedPaneId: null,
        })) ?? s
      )
    }),

  adopt: (layouts) => {
    set((s) => ({ byWorkspace: { ...s.byWorkspace, ...layouts } }))
    for (const [workspaceId, layout] of Object.entries(layouts)) {
      for (const paneId of paneIds(layout.root)) {
        window.pine?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId })
      }
    }
  },
}))
