import { openNewWindow } from '@/lib/workspaces/newWorkspace'
import {
  movePaneToNewWindow,
  moveWorkspaceToNewWindow,
  returnToMainWindow,
} from '@/lib/workspaces/windowHandoff'
import { registerCore } from './core'

export function registerWindowCommands(detached: boolean): void {
  registerCore<undefined, { opened: boolean }>({
    id: 'window.new',
    category: 'window',
    target: 'none',
    capabilities: ['drive-self'],
    run: async () => ({ opened: await openNewWindow() }),
  })
  if (detached) {
    registerCore<undefined, { moved: boolean }>({
      id: 'window.moveToMain',
      category: 'window',
      target: 'none',
      capabilities: ['drive-self'],
      run: async () => ({ moved: await returnToMainWindow() }),
    })
    return
  }
  registerCore<undefined, { moved: boolean }>({
    id: 'workspace.moveToNewWindow',
    category: 'workspace',
    capabilities: ['drive-self'],
    run: async (_args, ctx) => ({
      moved: ctx.activeWorkspaceId ? await moveWorkspaceToNewWindow(ctx.activeWorkspaceId) : false,
    }),
  })
  registerCore<undefined, { moved: boolean }>({
    id: 'pane.moveToNewWindow',
    category: 'pane',
    capabilities: ['drive-self'],
    run: async (_args, ctx) => ({
      moved:
        ctx.activeWorkspaceId && ctx.activePaneId
          ? await movePaneToNewWindow(ctx.activeWorkspaceId, ctx.activePaneId)
          : false,
    }),
  })
}
