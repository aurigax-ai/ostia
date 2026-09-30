import {
  movePaneToNewWindow,
  moveWorkspaceToNewWindow,
  returnToMainWindow,
} from '../lib/windowHandoff'
import { commands } from './registry'

export function registerWindowCommands(detached: boolean): void {
  if (detached) {
    commands.register<undefined, { moved: boolean }>({
      id: 'window.moveToMain',
      title: 'Move Back to Main Window',
      category: 'Window',
      target: 'none',
      capabilities: ['drive-self'],
      run: async () => ({ moved: await returnToMainWindow() }),
    })
    return
  }
  commands.register<undefined, { moved: boolean }>({
    id: 'workspace.moveToNewWindow',
    title: 'Move Workspace to New Window',
    category: 'Workspace',
    capabilities: ['drive-self'],
    run: async (_args, ctx) => ({
      moved: ctx.activeWorkspaceId ? await moveWorkspaceToNewWindow(ctx.activeWorkspaceId) : false,
    }),
  })
  commands.register<undefined, { moved: boolean }>({
    id: 'pane.moveToNewWindow',
    title: 'Move Pane to New Window',
    category: 'Pane',
    capabilities: ['drive-self'],
    run: async (_args, ctx) => ({
      moved:
        ctx.activeWorkspaceId && ctx.activePaneId
          ? await movePaneToNewWindow(ctx.activeWorkspaceId, ctx.activePaneId)
          : false,
    }),
  })
}
