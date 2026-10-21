import { create } from 'zustand'
import { setDefaultPaneTitles, setPaneBrowser, setPaneCwd } from '@/lib/layout/paneFields'
import { setSizes } from '@/lib/layout/panelSize'
import { focusAfterClose, showAfterClose } from '@/lib/layout/tabFocus'
import {
  addTab,
  closePane,
  createPane,
  findPane,
  firstPaneId,
  paneIds,
  splitPane,
} from '@/lib/layout/tree'
import { layoutOf, patch, successorOf } from '@/lib/panes/layoutPatch'
import { forgetTab, noteOpener, tabHistoryOf } from '@/lib/panes/tabHistory'
import { keepKeyboard } from './keepKeyboard'
import { createLayoutFileActions } from './layoutFileActions'
import { createLayoutOpenActions } from './layoutOpenActions'
import { createLayoutPaneActions } from './layoutPaneActions'
import { createLayoutPanelActions } from './layoutPanelActions'
import { announcePaneCreated, neutralTerminalTitle, newTerminalPane } from './layoutSeed'
import { createLayoutTabActions } from './layoutTabActions'
import { createLayoutTransferActions } from './layoutTransferActions'
import type { LayoutState } from './layoutTypes'
import { surfaceHoldsKeyboard } from './surfaceSlotsStore'
import { workDirOf } from './workspaceLookup'

export const useLayoutStore = create<LayoutState>((set, get) => ({
  byWorkspace: {},

  ensure: (workspaceId) => {
    let createdPaneId: string | null = null
    set((s) => {
      if (s.byWorkspace[workspaceId]) return s
      const root = newTerminalPane(workDirOf(workspaceId))
      createdPaneId = firstPaneId(root)
      return {
        byWorkspace: {
          ...s.byWorkspace,
          [workspaceId]: layoutOf(root),
        },
      }
    })
    announcePaneCreated(workspaceId, createdPaneId)
  },

  hydrate: (layouts) => {
    const title = neutralTerminalTitle()
    set({
      byWorkspace: Object.fromEntries(
        Object.entries(layouts).map(([workspaceId, layout]) => [
          workspaceId,
          { ...layout, root: setDefaultPaneTitles(layout.root, title) },
        ]),
      ),
    })
    for (const [workspaceId, layout] of Object.entries(layouts)) {
      for (const paneId of paneIds(layout.root)) {
        window.ostia.lifecycle.emit({ type: 'pane-created', workspaceId, paneId })
      }
    }
  },

  split: (workspaceId, paneId, direction) => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const result = splitPane(l.root, paneId, direction, newTerminalPane())
        createdPaneId = result.newPaneId
        const workDir = workDirOf(workspaceId)
        const root =
          result.newPaneId && workDir
            ? setPaneCwd(result.root, result.newPaneId, workDir)
            : result.root
        return { ...l, root, activePaneId: result.newPaneId ?? l.activePaneId }
      })
      return next ?? s
    })
    announcePaneCreated(workspaceId, createdPaneId)
  },

  newTab: (workspaceId, paneId, kind, browserProfile = 'isolated') => {
    let createdPaneId: string | null = null
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const target = findPane(l.root, paneId)
        if (!target) return l
        const pane =
          kind === 'terminal' ? newTerminalPane(workDirOf(workspaceId)) : createPane(kind)
        const root =
          kind === 'browser'
            ? setPaneBrowser(addTab(l.root, paneId, pane), pane.id, 'about:blank', browserProfile)
            : addTab(l.root, paneId, pane)
        createdPaneId = pane.id
        return { ...l, root, activePaneId: pane.id, zoomedPaneId: null }
      })
      return next ?? s
    })
    if (createdPaneId) {
      noteOpener(workspaceId, createdPaneId, paneId)
    }
    announcePaneCreated(workspaceId, createdPaneId)
    return createdPaneId
  },

  closePane: (workspaceId, paneId) => {
    if (get().isLocked(workspaceId, paneId)) return
    const current = get().byWorkspace[workspaceId]
    if (current?.root.type === 'pane' && current.root.id === paneId) {
      set((s) => {
        const { [workspaceId]: _emptied, ...byWorkspace } = s.byWorkspace
        return { byWorkspace }
      })
      window.ostia.lifecycle.emit({ type: 'pane-closed', workspaceId, paneId })
      return
    }
    const heldKeyboard = surfaceHoldsKeyboard(paneId)
    let removed = false
    set((s) => {
      const next = patch(s, workspaceId, (l) => {
        const shown = focusAfterClose(l.root, paneId, tabHistoryOf(workspaceId))
        const root = showAfterClose(closePane(l.root, paneId), shown)
        removed = findPane(l.root, paneId) !== null && findPane(root, paneId) === null
        const activePaneId =
          removed && paneId === l.activePaneId
            ? (shown ?? successorOf(l.root, root, paneId))
            : l.activePaneId
        const zoomedPaneId = removed && l.zoomedPaneId === paneId ? null : l.zoomedPaneId
        return { root, activePaneId, zoomedPaneId }
      })
      return next ?? s
    })
    if (removed) {
      forgetTab(workspaceId, paneId)
      if (heldKeyboard) keepKeyboard(get, workspaceId)
      window.ostia.lifecycle.emit({ type: 'pane-closed', workspaceId, paneId })
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

  ...createLayoutPaneActions(set, get),
  ...createLayoutTabActions(set, get),
  ...createLayoutFileActions(set, get),
  ...createLayoutOpenActions(set, get),
  ...createLayoutPanelActions(set, get),
  ...createLayoutTransferActions(set, get),
}))
