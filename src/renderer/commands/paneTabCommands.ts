import { normalizeSplitTabName } from '@shared/workspaces/splitTabs'
import {
  allPanes,
  findPane,
  findSplitTabByName,
  splitTabOfPane,
  tabsOfPane,
} from '@/lib/layout/tree'
import { isAgentSplitTab } from '@/lib/panes/agentSplitTabs'
import { splitTabSeed } from '@/lib/panes/splitTabSeeds'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { registerCore } from './coreCommand'

interface PaneTabArgs {
  paneIds: string[]
  tab: string | null
}

const PANE_TAB_SCHEMA = {
  type: 'object',
  properties: {
    paneIds: { type: 'array', items: { type: 'string' } },
    tab: { type: ['string', 'null'] },
  },
  required: ['paneIds', 'tab'],
}

function tabOf(raw: unknown): string | null {
  if (raw === null) return null
  const name = normalizeSplitTabName(raw)
  if (!name) throw new Error('bad-request: tab')
  return name
}

function paneIdsOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((id): id is string => typeof id === 'string' && !!id)) {
    throw new Error('bad-request: paneIds')
  }
  return raw
}

function refusedPanes(paneIds: readonly string[]): { locked: string[]; manager: string[] } {
  const panes = Object.values(useLayoutStore.getState().byWorkspace).flatMap((l) =>
    paneIds.map((id) => findPane(l.root, id)).filter((p) => p !== null),
  )
  return {
    locked: panes.filter((p) => p.locked).map((p) => p.id),
    manager: panes.filter((p) => p.kind === 'manager').map((p) => p.id),
  }
}

function tabMembers(workspaceId: string, tab: string): string[] {
  const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
  if (!root) return []
  const named = findSplitTabByName(root, tab)
  if (named) return allPanes(named).map((p) => p.id)
  const seed = splitTabSeed(workspaceId, tab)
  return seed && findPane(root, seed) && !splitTabOfPane(root, seed) ? [seed] : []
}

function humanTabOf(workspaceId: string, tab: string | null, paneIds: readonly string[]) {
  const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
  if (!root) return null
  const touched =
    tab === null ? paneIds.map((id) => splitTabOfPane(root, id)) : [findSplitTabByName(root, tab)]
  return touched.find((t) => t && !isAgentSplitTab(t.id)) ?? null
}

function humanTabRefusal(name: string | undefined): Error {
  return new Error(
    `human-tab: split tab ${name ?? '(unnamed)'} is the human's; agents join only split tabs an agent made`,
  )
}

function activeSplitTabId(workspaceId: string | null, paneId: string | null): string | null {
  const root = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId]?.root : null
  return root && paneId ? (splitTabOfPane(root, paneId)?.id ?? null) : null
}

function shownSplitTabId(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const paneId = workspaceId
    ? useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
    : null
  return activeSplitTabId(workspaceId, paneId ?? null)
}

const COLLAPSE_COMMANDS = [
  ['pane.collapse', 'collapse'],
  ['pane.collapseOthers', 'collapseOthers'],
  ['pane.expandAll', 'expandAll'],
] as const

export function registerPaneTabCommands(): void {
  for (const [id, change] of COLLAPSE_COMMANDS) {
    registerCore<{ paneId?: string } | undefined>({
      id,
      category: 'pane',
      local: true,
      listed: () => shownSplitTabId() !== null,
      run: (args, ctx) => {
        const paneId = args?.paneId ?? ctx.activePaneId
        if (ctx.activeWorkspaceId && paneId) {
          useLayoutStore.getState().changeCollapse(ctx.activeWorkspaceId, paneId, change)
        }
      },
    })
  }

  registerCore<{ tabId?: string } | undefined>({
    id: 'pane.foldSplitTab',
    category: 'pane',
    local: true,
    listed: () => shownSplitTabId() !== null,
    run: (args, ctx) => {
      const tabId = args?.tabId ?? activeSplitTabId(ctx.activeWorkspaceId, ctx.activePaneId)
      if (ctx.activeWorkspaceId && tabId) {
        useLayoutStore.getState().foldSplitTab(ctx.activeWorkspaceId, tabId)
      }
    },
  })

  registerCore<{ tabId?: string } | undefined>({
    id: 'pane.ungroupSplitTab',
    category: 'pane',
    local: true,
    listed: () => shownSplitTabId() !== null,
    run: (args, ctx) => {
      const tabId = args?.tabId ?? activeSplitTabId(ctx.activeWorkspaceId, ctx.activePaneId)
      if (ctx.activeWorkspaceId && tabId) {
        useLayoutStore.getState().ungroupSplitTab(ctx.activeWorkspaceId, tabId)
      }
    },
  })

  registerCore({
    id: 'pane.renameSplitTab',
    category: 'pane',
    local: true,
    listed: () => shownSplitTabId() !== null,
    run: (_args, ctx) => {
      const tabId = activeSplitTabId(ctx.activeWorkspaceId, ctx.activePaneId)
      if (!tabId) throw new Error('the active pane is not in a split tab')
      usePaneRenameStore.getState().beginSplitTab(tabId)
    },
  })

  registerCore<{ paneId: string }, { name: string | null; human: boolean }>({
    id: 'pane.splitTabOf',
    category: 'pane',
    local: true,
    run: (args, ctx) => {
      const root = ctx.activeWorkspaceId
        ? useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]?.root
        : null
      const tab =
        root && typeof args?.paneId === 'string' ? splitTabOfPane(root, args.paneId) : null
      return { name: tab?.name ?? null, human: tab !== null && !isAgentSplitTab(tab.id) }
    },
  })

  registerCore<PaneTabArgs, { members: string[]; locked: string[]; human: string | null }>({
    id: 'pane.tabPlan',
    category: 'pane',
    local: true,
    argsSchema: PANE_TAB_SCHEMA,
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) throw new Error('no target workspace')
      const tab = tabOf(args?.tab)
      const paneIds = paneIdsOf(args?.paneIds)
      const human = humanTabOf(workspaceId, tab, paneIds)
      return {
        members: tab ? tabMembers(workspaceId, tab) : [],
        locked: refusedPanes(paneIds).locked,
        human: human ? (human.name ?? '') : null,
      }
    },
  })

  function coversWorkspace(workspaceId: string, paneIds: readonly string[], tab: string): boolean {
    const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
    if (root?.type !== 'split' || findSplitTabByName(root, tab)) return false
    return paneIds.every((id) => findPane(root, id) && !tabsOfPane(root, id))
  }

  registerCore<PaneTabArgs, { moved: string[]; whole: boolean }>({
    id: 'pane.joinTab',
    category: 'pane',
    local: true,
    argsSchema: PANE_TAB_SCHEMA,
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      const root = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId]?.root : null
      if (!workspaceId || !root) throw new Error('no target workspace')
      const tab = tabOf(args?.tab)
      const paneIds = paneIdsOf(args?.paneIds)
      const missing = paneIds.find((id) => !findPane(root, id))
      if (missing) throw new Error(`unknown-pane: ${missing}`)
      const { locked, manager } = refusedPanes(paneIds)
      if (manager.length > 0) throw new Error(`unknown-pane: ${manager[0]}`)
      if (locked.length > 0) {
        throw new Error('pane-locked: the human locked this pane; only they can unlock it')
      }
      const human = humanTabOf(workspaceId, tab, paneIds)
      if (human) throw humanTabRefusal(human.name)
      const moved = useLayoutStore.getState().joinTab(workspaceId, paneIds, tab)
      return { moved, whole: tab !== null && coversWorkspace(workspaceId, paneIds, tab) }
    },
  })
}
