import {
  findViewPane,
  firstPaneOfKind,
  setPaneChat,
  setPaneDiff,
  setPaneGit,
  setPaneView,
} from '@/lib/layout/paneFields'
import { panelKey, sizePanel } from '@/lib/layout/panelSize'
import { addTab, createPane, findPane, splitBeside } from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { patch } from '@/lib/panes/layoutPatch'
import { rememberedPanelFraction } from '@/lib/panes/panelSizes'
import { useDiffStore } from '@/stores/files/diffStore'
import { seedLayout } from './layoutSeed'
import type { LayoutGet, LayoutSet, LayoutState, WorkspaceLayout } from './layoutTypes'

function withRememberedPanelSize(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const pane = findPane(layout.root, paneId)
  const key = pane ? panelKey(pane) : null
  const fraction = key ? rememberedPanelFraction(key) : null
  if (fraction === null) return layout
  const root = sizePanel(layout.root, paneId, fraction)
  return root === layout.root ? layout : { ...layout, root }
}

function openSingleton(
  set: LayoutSet,
  get: LayoutGet,
  workspaceId: string,
  find: (root: LayoutNode) => PaneNode | null,
  apply: (root: LayoutNode, paneId: string) => LayoutNode,
): string | null {
  const seeded = seedLayout(set, get, workspaceId, (p) => apply(p, p.id))
  if (seeded) return seeded
  let createdPaneId: string | null = null
  let targetPaneId: string | null = null
  set((s) => {
    const next = patch(s, workspaceId, (l) => {
      const existing = find(l.root)
      if (existing) {
        targetPaneId = existing.id
        return { ...l, activePaneId: existing.id }
      }
      const { root, newPaneId } = splitBeside(l.root, l.activePaneId, 'horizontal')
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
    window.ostia?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId: createdPaneId })
  }
  return targetPaneId
}

type LayoutPanelActions = Pick<
  LayoutState,
  'openGit' | 'openView' | 'openChat' | 'setChatSession' | 'openDiff'
>

export function createLayoutPanelActions(set: LayoutSet, get: LayoutGet): LayoutPanelActions {
  return {
    openGit: (workspaceId, title) =>
      openSingleton(
        set,
        get,
        workspaceId,
        (root) => firstPaneOfKind(root, 'git'),
        (root, paneId) => setPaneGit(root, paneId, title),
      ),

    openView: (workspaceId, viewName, title) =>
      openSingleton(
        set,
        get,
        workspaceId,
        (root) => findViewPane(root, viewName),
        (root, paneId) => setPaneView(root, paneId, viewName, title),
      ),

    openChat: (workspaceId, title) =>
      openSingleton(
        set,
        get,
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
      const seeded = seedLayout(set, get, workspaceId, (p) =>
        setPaneDiff(p, p.id, content.title, cwd),
      )
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
          const pane = createPane('diff')
          createdPaneId = pane.id
          diffPaneId = pane.id
          return {
            ...l,
            root: setPaneDiff(addTab(l.root, l.activePaneId, pane), pane.id, content.title, cwd),
            activePaneId: pane.id,
          }
        })
        return next ?? s
      })
      if (diffPaneId) useDiffStore.getState().set(diffPaneId, content)
      if (createdPaneId) {
        window.ostia?.lifecycle?.emit?.({
          type: 'pane-created',
          workspaceId,
          paneId: createdPaneId,
        })
      }
      return diffPaneId
    },
  }
}
