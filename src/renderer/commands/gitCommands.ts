import { currentDict } from '@/lib/app/useDict'
import { neighborChange, orderedChanges } from '@/lib/git/changeNeighbor'
import { openGit } from '@/lib/git/gitPanel'
import { findPane } from '@/lib/layout/tree'
import { useDiffStore } from '@/stores/files/diffStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { registerCore } from './coreCommand'
import type { CommandContext } from './registry'

function activeFile(ctx: CommandContext): string | null {
  const { activeWorkspaceId, activePaneId } = ctx
  if (!activeWorkspaceId || !activePaneId) return null
  const layout = useLayoutStore.getState().byWorkspace[activeWorkspaceId]
  const pane = layout ? findPane(layout.root, activePaneId) : null
  return pane?.kind === 'editor' && pane.filePath ? pane.filePath : null
}

async function openAdjacentChange(
  ctx: CommandContext,
  paneId: string | undefined,
  step: 1 | -1,
): Promise<void> {
  const workspaceId = ctx.activeWorkspaceId
  const shown = useDiffStore.getState().byPane[paneId ?? ctx.activePaneId ?? '']
  if (!workspaceId || !shown?.path || !shown.area) throw new Error(currentDict().git.noChangedDiff)
  const res = await window.ostia.git.changes(workspaceId)
  if (!res.ok) return
  const list = orderedChanges(res.data.root, res.data.changes)
  const target = neighborChange(list, { path: shown.path, area: shown.area }, step)
  if (target) await window.ostia.git.openChange(workspaceId, target.path, target.area)
}

export function registerGitCommands(): void {
  for (const [id, step] of [
    ['git.openNextChange', 1],
    ['git.openPreviousChange', -1],
  ] as const) {
    registerCore<{ paneId?: string } | undefined>({
      id,
      category: 'git',
      target: 'active',
      capabilities: ['read-board'],
      run: (args, ctx) => openAdjacentChange(ctx, args?.paneId, step),
    })
  }

  registerCore({
    id: 'git.show',
    category: 'git',
    target: 'active',
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) openGit(ctx.activeWorkspaceId, 'changes')
    },
  })

  registerCore({
    id: 'git.showGraph',
    category: 'git',
    target: 'active',
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) openGit(ctx.activeWorkspaceId, 'graph')
    },
  })

  registerCore({
    id: 'git.blameFile',
    category: 'git',
    target: 'active',
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      const file = activeFile(ctx)
      if (!file || !ctx.activeWorkspaceId) throw new Error(currentDict().git.noFile)
      openGit(ctx.activeWorkspaceId, 'blame', file)
    },
  })
}
