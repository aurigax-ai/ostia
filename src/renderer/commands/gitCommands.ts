import { openGit } from '@/lib/git/gitPanel'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { currentDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { registerCore } from './core'
import type { CommandContext } from './registry'

function activeFile(ctx: CommandContext): string | null {
  const { activeWorkspaceId, activePaneId } = ctx
  if (!activeWorkspaceId || !activePaneId) return null
  const layout = useLayoutStore.getState().byWorkspace[activeWorkspaceId]
  const pane = layout ? findPane(layout.root, activePaneId) : null
  return pane?.kind === 'editor' && pane.filePath ? pane.filePath : null
}

export function registerGitCommands(): void {
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
