import { allPanes, findPane, findSplitTabByName, splitTabOfPane } from '@/layout/tree'
import { splitTabSeed } from '@/lib/panes/splitTabSeeds'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { normalizeSplitTabName } from '@shared/workspaces/splitTabs'
import { registerCore } from './core'

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

export function registerPaneTabCommands(): void {
  registerCore<PaneTabArgs, { members: string[]; locked: string[] }>({
    id: 'pane.tabPlan',
    category: 'pane',
    hidden: true,
    capabilities: ['all-workspaces', 'type-other-pane'],
    argsSchema: PANE_TAB_SCHEMA,
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) throw new Error('no target workspace')
      const tab = tabOf(args?.tab)
      const paneIds = paneIdsOf(args?.paneIds)
      return {
        members: tab ? tabMembers(workspaceId, tab) : [],
        locked: refusedPanes(paneIds).locked,
      }
    },
  })

  registerCore<PaneTabArgs, { moved: string[] }>({
    id: 'pane.joinTab',
    category: 'pane',
    hidden: true,
    capabilities: ['all-workspaces', 'type-other-pane'],
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
      return { moved: useLayoutStore.getState().joinTab(workspaceId, paneIds, tab) }
    },
  })
}
