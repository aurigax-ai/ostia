import { ASSIST_COMPOSE_COMMAND } from '@/commands/assistCompose'
import { commands } from '@/commands/registry'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { AssistOpenUiRequest } from '@shared/assist'
import { openChatPane } from './chatPane'

export function openAssistUi(req: AssistOpenUiRequest): void {
  const workspaces = useWorkspacesStore.getState()
  const known = req.workspaceId && workspaces.workspaces.some((w) => w.id === req.workspaceId)
  if (req.ui === 'chat') {
    openChatPane(known && req.workspaceId ? { workspaceId: req.workspaceId } : {})
    return
  }
  if (known && req.workspaceId && workspaces.activeWorkspaceId !== req.workspaceId) {
    workspaces.setActive(req.workspaceId)
  }
  const ui = useUIStore.getState()
  ui.showWorkspaces()
  if (req.ui === 'ask') ui.openPalette('ask')
  else if (commands.has(ASSIST_COMPOSE_COMMAND)) void commands.exec(ASSIST_COMPOSE_COMMAND)
}

export function startAssistUi(): () => void {
  return window.ostia?.assist?.onOpenUi?.(openAssistUi) ?? (() => {})
}
