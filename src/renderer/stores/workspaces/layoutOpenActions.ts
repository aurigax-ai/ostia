import { browserPaneInUse, setPaneBrowser, setPaneCwd, setPaneTitle } from '@/lib/layout/paneFields'
import {
  addTab,
  backgroundTabAnchor,
  createPane,
  findPane,
  findSplitTabByName,
  splitBeside,
} from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { patch } from '@/lib/panes/layoutPatch'
import { joinedTerminal, markNewSplitTab, splitTabAnchor } from '@/lib/panes/splitTabPlacement'
import { forgetSplitTabSeeds, seedSplitTab } from '@/lib/panes/splitTabSeeds'
import { noteOpener } from '@/lib/panes/tabHistory'
import { announcePaneCreated, newTerminalPane, seedLayout } from './layoutSeed'
import type { LayoutGet, LayoutSet, LayoutState, OpenTerminalPlacement } from './layoutTypes'

function describeTerminal(root: LayoutNode, paneId: string, opts: OpenTerminalPlacement) {
  const withCwd = opts.cwd ? setPaneCwd(root, paneId, opts.cwd) : root
  return opts.title ? setPaneTitle(withCwd, paneId, opts.title) : withCwd
}

type LayoutOpenActions = Pick<
  LayoutState,
  'openTerminalTab' | 'openBrowser' | 'openBrowserTab' | 'openManager' | 'openTerminal'
>

export function createLayoutOpenActions(set: LayoutSet, get: LayoutGet): LayoutOpenActions {
  return {
    openTerminalTab: (workspaceId, cwd) => {
      const layout = get().byWorkspace[workspaceId]
      if (!layout) return get().openTerminal(workspaceId, { cwd })
      const paneId = get().newTab(workspaceId, layout.activePaneId, 'terminal')
      if (paneId) get().setCwd(workspaceId, paneId, cwd)
      return paneId
    },

    openBrowser: (workspaceId, url, profile) => {
      if (seedLayout(set, get, workspaceId, (p) => setPaneBrowser(p, p.id, url, profile))) return
      let createdPaneId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const existing = browserPaneInUse(l.root, l.activePaneId, profile)
          if (existing) {
            return {
              ...l,
              root: setPaneBrowser(l.root, existing.id, url),
              activePaneId: existing.id,
            }
          }
          const pane = createPane('browser')
          createdPaneId = pane.id
          return {
            ...l,
            root: setPaneBrowser(addTab(l.root, l.activePaneId, pane), pane.id, url, profile),
            activePaneId: pane.id,
          }
        })
        return next ?? s
      })
      announcePaneCreated(workspaceId, createdPaneId)
    },

    openBrowserTab: (workspaceId, url, profile, placement = {}) => {
      const seeded = seedLayout(set, get, workspaceId, (p) => setPaneBrowser(p, p.id, url, profile))
      if (seeded) return seeded
      let createdPaneId: string | null = null
      let openerId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const asked = placement.beside && findPane(l.root, placement.beside)
          const beside = asked
            ? asked.id
            : (browserPaneInUse(l.root, l.activePaneId, profile)?.id ?? l.activePaneId)
          const pane = createPane('browser')
          createdPaneId = pane.id
          openerId = beside
          const quiet = placement.background === true
          const root = setPaneBrowser(addTab(l.root, beside, pane, quiet), pane.id, url, profile)
          return quiet ? { ...l, root } : { ...l, root, activePaneId: pane.id }
        })
        return next ?? s
      })
      if (createdPaneId && openerId) noteOpener(workspaceId, createdPaneId, openerId)
      announcePaneCreated(workspaceId, createdPaneId)
      return createdPaneId
    },

    openManager: (workspaceId, opts) =>
      seedLayout(set, get, workspaceId, (p) => ({
        type: 'pane',
        id: p.id,
        kind: 'manager',
        cwd: opts.cwd,
        title: opts.title,
      })),

    openTerminal: (workspaceId, opts) => {
      const seeded = seedLayout(set, get, workspaceId, (p) => describeTerminal(p, p.id, opts))
      if (seeded) return seeded
      let createdPaneId: string | null = null
      set((s) => {
        const next = patch(s, workspaceId, (l) => {
          const beside =
            opts.afterPaneId && findPane(l.root, opts.afterPaneId)
              ? opts.afterPaneId
              : l.activePaneId
          const anchor = opts.splitTab ? splitTabAnchor(workspaceId, l.root, opts.splitTab) : null
          if (anchor && opts.splitTab) {
            const pane = newTerminalPane()
            createdPaneId = pane.id
            forgetSplitTabSeeds([anchor])
            const root = joinedTerminal(l.root, anchor, pane, opts.splitTab)
            markNewSplitTab(l.root, root, opts.splitTab.name)
            return { ...l, root: describeTerminal(root, pane.id, opts) }
          }
          if (opts.asTab) {
            const pane = newTerminalPane()
            createdPaneId = pane.id
            return {
              root: describeTerminal(addTab(l.root, beside, pane), pane.id, opts),
              activePaneId: pane.id,
              zoomedPaneId: null,
            }
          }
          if (opts.backgroundTab) {
            const pane = newTerminalPane()
            createdPaneId = pane.id
            if (opts.splitTab && !findSplitTabByName(l.root, opts.splitTab.name)) {
              seedSplitTab(workspaceId, opts.splitTab.name, pane.id)
            }
            const after = backgroundTabAnchor(l.root, beside, opts.openedPaneIds ?? [])
            return {
              ...l,
              root: describeTerminal(addTab(l.root, after, pane, true), pane.id, opts),
            }
          }
          const { root, newPaneId } = splitBeside(l.root, beside, 'horizontal', newTerminalPane())
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
      announcePaneCreated(workspaceId, createdPaneId)
      return createdPaneId
    },
  }
}
