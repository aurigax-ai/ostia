import { type CoreCommandId, delegate, registerCore } from '@/commands/coreCommand'
import type { CommandContext } from '@/commands/registry'
import { currentDict } from '@/lib/app/useDict'
import { focusAdjacentTab, focusPaneInDirection } from '@/lib/attention/workspaceActivity'
import { browserProfileIn, openerOf } from '@/lib/browser/browserProfile'
import type { FocusDirection } from '@/lib/layout/focusDirection'
import { type DropZone, findPane, tabIdOf, tabNeighbor } from '@/lib/layout/tree'
import type { Direction } from '@/lib/layout/types'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import {
  closePaneForAgent,
  requestClosePane,
  requestCloseWorkspace,
} from '@/lib/workspaces/closeConfirm'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { tabMoveRefusalText } from '@/lib/workspaces/tabMoveRefusalText'
import {
  activeTabId,
  moveTabToWorkspace,
  tabMoveRefusalFor,
  tabMoveTargets,
} from '@/lib/workspaces/tabWorkspaceMove'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const PANE_FOCUS_COMMANDS: readonly (readonly [CoreCommandId, FocusDirection])[] = [
  ['pane.focusLeft', 'left'],
  ['pane.focusRight', 'right'],
  ['pane.focusUp', 'up'],
  ['pane.focusDown', 'down'],
]

function workspaceWithoutPanes(ctx: CommandContext, paneId?: string): string | null {
  const workspaceId = ctx.activeWorkspaceId
  if (!workspaceId || paneId || ctx.activePaneId) return null
  return useLayoutStore.getState().byWorkspace[workspaceId] ? null : workspaceId
}

function openFirstTerminal(ctx: CommandContext, workspaceId: string): void {
  useLayoutStore.getState().ensure(workspaceId)
  if (ctx.origin !== 'remote') focusActivePaneWhenReady(workspaceId)
}

const PANE_LOCKED = 'pane-locked: the human locked this pane; only they can unlock it'

function registerOpenAndCloseCommands(): void {
  registerCore<{ paneId?: string; direction: Direction }>({
    id: 'pane.split',
    category: 'pane',
    hidden: true,
    run: ({ paneId, direction }, ctx) => {
      const empty = workspaceWithoutPanes(ctx, paneId)
      if (empty) {
        openFirstTerminal(ctx, empty)
        return
      }
      const target = paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().split(ctx.activeWorkspaceId, target, direction)
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(ctx.activeWorkspaceId)
      }
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'tab.new',
    category: 'pane',
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId && !args?.paneId) {
        const created = startNewWorkspace()
        if (created) openFirstTerminal(ctx, created)
        return
      }
      const empty = workspaceWithoutPanes(ctx, args?.paneId)
      if (empty) {
        openFirstTerminal(ctx, empty)
        return
      }
      const target =
        args?.paneId ??
        ctx.activePaneId ??
        (ctx.activeWorkspaceId
          ? useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]?.activePaneId
          : null)
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'terminal')
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(ctx.activeWorkspaceId)
      }
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'tab.newBrowser',
    category: 'pane',
    capabilities: ['browse'],
    run: (args, ctx) => {
      const empty = workspaceWithoutPanes(ctx, args?.paneId)
      if (empty) {
        const profile = browserProfileIn(empty, openerOf(ctx))
        useLayoutStore.getState().openBrowser(empty, 'about:blank', profile)
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(empty)
        return
      }
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        const profile = browserProfileIn(ctx.activeWorkspaceId, openerOf(ctx))
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'browser', profile)
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(ctx.activeWorkspaceId)
      }
    },
  })

  registerCore({
    id: 'pane.splitRight',
    category: 'pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'horizontal' }),
  })

  registerCore({
    id: 'pane.splitDown',
    category: 'pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'vertical' }),
  })

  registerCore<{ paneId?: string }>({
    id: 'pane.close',
    category: 'pane',
    capabilities: ['kill-pane'],
    argsSchema: { type: 'object', properties: { paneId: { type: 'string' } } },
    run: async (args, ctx) => {
      if (args?.paneId !== undefined && typeof args.paneId !== 'string') {
        throw new Error('paneId must be a string')
      }
      if (args?.paneId === undefined && !ctx.target) {
        const ui = useUIStore.getState()
        if (ui.settingsActive) {
          ui.closeSettings()
          return
        }
        if (ui.dashboardActive) {
          ui.showWorkspaces()
          return
        }
      }
      if (!ctx.activeWorkspaceId) {
        if (args?.paneId !== undefined) throw new Error(`unknown-pane: ${args.paneId}`)
        return
      }
      const target = args?.paneId ?? ctx.activePaneId
      const layout = useLayoutStore.getState()
      if (args?.paneId !== undefined) {
        const tree = layout.byWorkspace[ctx.activeWorkspaceId]
        if (!tree || !findPane(tree.root, args.paneId)) {
          throw new Error(`unknown-pane: ${args.paneId}`)
        }
      }
      if (!target) {
        const empty = !args?.paneId && !layout.byWorkspace[ctx.activeWorkspaceId]
        if (empty && !ctx.target) await requestCloseWorkspace(ctx.activeWorkspaceId)
        return
      }
      if (!ctx.target) {
        await requestClosePane(ctx.activeWorkspaceId, target)
        return
      }
      if (layout.isLocked(ctx.activeWorkspaceId, target)) throw new Error(PANE_LOCKED)
      await closePaneForAgent(ctx.activeWorkspaceId, target)
    },
  })

  registerCore<{ paneId?: string } | undefined, { locked: boolean }>({
    id: 'pane.locked',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (!ctx.activeWorkspaceId || !target) throw new Error('no target pane')
      return { locked: useLayoutStore.getState().isLocked(ctx.activeWorkspaceId, target) }
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'pane.toggleLock',
    category: 'pane',
    local: true,
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (!ctx.activeWorkspaceId || !target) return
      const layout = useLayoutStore.getState()
      layout.setLocked(
        ctx.activeWorkspaceId,
        target,
        !layout.isLocked(ctx.activeWorkspaceId, target),
      )
    },
  })
}

function registerFocusAndMoveCommands(): void {
  registerCore<{ paneId: string }>({
    id: 'pane.focus',
    category: 'pane',
    hidden: true,
    run: ({ paneId }, ctx) => {
      if (ctx.activeWorkspaceId && paneId) {
        useLayoutStore.getState().focusPane(ctx.activeWorkspaceId, paneId)
      }
    },
  })

  for (const [id, direction] of PANE_FOCUS_COMMANDS) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        if (ctx.activeWorkspaceId && ctx.activePaneId) {
          focusPaneInDirection(ctx.activeWorkspaceId, ctx.activePaneId, direction)
        }
      },
    })
  }

  for (const [id, step] of [
    ['tab.next', 1],
    ['tab.previous', -1],
  ] as const) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        if (ctx.activeWorkspaceId && ctx.activePaneId) {
          focusAdjacentTab(ctx.activeWorkspaceId, ctx.activePaneId, step)
        }
      },
    })
  }

  for (const [id, step] of [
    ['tab.moveLeft', -1],
    ['tab.moveRight', 1],
  ] as const) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        const workspaceId = ctx.activeWorkspaceId
        const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
        if (!workspaceId || !layout || !ctx.activePaneId) return
        const neighbor = tabNeighbor(layout.root, ctx.activePaneId, step)
        const source = tabIdOf(layout.root, ctx.activePaneId)
        if (!neighbor || !source) return
        useLayoutStore.getState().moveTab(workspaceId, source, neighbor, step === 1)
      },
    })
  }

  registerCore<{ workspaceId: string }, { moved: string[] }>({
    id: 'pane.moveToWorkspace',
    category: 'pane',
    hidden: true,
    capabilities: ['all-workspaces', 'type-other-pane'],
    argsSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
    run: async (args, ctx) => {
      const source = ctx.activeWorkspaceId
      const paneId = ctx.activePaneId
      if (!source || !paneId) throw new Error('no target pane')
      if (typeof args?.workspaceId !== 'string') throw new Error('workspaceId must be a string')
      const refusal = tabMoveRefusalFor(source, paneId, args.workspaceId)
      if (refusal) throw new Error(`${refusal}: ${currentDict().tabMove[refusal]}`)
      if (!(await moveTabToWorkspace(source, paneId, args.workspaceId))) {
        throw new Error('move-failed: the pane did not move')
      }
      return { moved: [paneId] }
    },
  })

  registerCore<{ argument?: string } | undefined, { moved: boolean }>({
    id: 'tab.moveToWorkspace',
    category: 'pane',
    local: true,
    choices: async () => {
      const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
      const tabId = workspaceId ? activeTabId(workspaceId) : null
      if (!workspaceId || !tabId) return []
      const d = currentDict()
      return tabMoveTargets(workspaceId, tabId).map((t) => {
        const reason = tabMoveRefusalText(d, t.refusal)
        return { value: t.id, label: t.name, ...(reason ? { disabledReason: reason } : {}) }
      })
    },
    emptyChoices: () => currentDict().tabMove.noTargets,
    run: async (args, ctx) => {
      const target = args?.argument
      const tabId = ctx.activeWorkspaceId ? activeTabId(ctx.activeWorkspaceId) : null
      if (!ctx.activeWorkspaceId || !tabId || !target) return { moved: false }
      return { moved: await moveTabToWorkspace(ctx.activeWorkspaceId, tabId, target) }
    },
  })

  registerCore<{ paneId?: string; zoom?: boolean } | undefined>({
    id: 'pane.zoom',
    category: 'pane',
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().zoomPane(ctx.activeWorkspaceId, target, args?.zoom)
      }
    },
  })

  registerCore<{ sourceId: string; targetId: string; zone: DropZone }>({
    id: 'pane.move',
    category: 'pane',
    hidden: true,
    run: ({ sourceId, targetId, zone }, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().movePane(ctx.activeWorkspaceId, sourceId, targetId, zone)
      }
    },
  })

  registerCore<{ sourceId: string; targetId: string; after: boolean }>({
    id: 'pane.moveTab',
    category: 'pane',
    hidden: true,
    run: ({ sourceId, targetId, after }, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().moveTab(ctx.activeWorkspaceId, sourceId, targetId, after)
      }
    },
  })
}

export function registerPaneLayoutCommands(): void {
  registerOpenAndCloseCommands()
  registerFocusAndMoveCommands()
}
