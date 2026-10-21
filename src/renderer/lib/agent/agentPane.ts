import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { currentDict } from '@/lib/app/useDict'
import { fileAttachment } from '@/lib/assist/askContext'
import { agentAttachmentKey, ensureAgentSession } from '@/stores/agent/agentStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useChatStore } from '@/stores/assist/chatStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export function openAgentPane(workspaceId?: string | null): string | null {
  const workspaces = useWorkspacesStore.getState()
  const id = workspaceId ?? workspaces.activeWorkspaceId
  if (!id || !workspaces.workspaces.some((w) => w.id === id)) return null
  const ui = useUIStore.getState()
  ui.closePalette()
  ui.showWorkspaces()
  if (workspaces.activeWorkspaceId !== id) workspaces.setActive(id)
  void ensureAgentSession(id)
  return useLayoutStore.getState().openAgent(id, currentDict().agentPane.paneTitle)
}

export function addToAgentPane(item: ChatContextItem, workspaceId?: string | null): boolean {
  const id = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  if (!id) return false
  useChatStore.getState().attach(agentAttachmentKey(id), item)
  return openAgentPane(id) !== null
}

export async function addFileToAgentPane(
  path: string,
  label: string,
  workspaceId?: string | null,
): Promise<boolean> {
  const item = await fileAttachment(path, label)
  return item ? addToAgentPane(item, workspaceId) : false
}
