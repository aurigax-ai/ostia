import type { ChatContextItem } from '@shared/assist'
import { chatFor, chatKey, ensureSession, nameSession, useChatStore } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export interface OpenChatOptions {
  workspaceId?: string
  context?: ChatContextItem[]
  prompt?: string
  send?: boolean
}

export const CHAT_PANE_TITLE = 'Chat'

export function openChatPane(opts: OpenChatOptions = {}): string | null {
  const workspaces = useWorkspacesStore.getState()
  const workspaceId = opts.workspaceId ?? workspaces.activeWorkspaceId
  if (!workspaceId || !workspaces.workspaces.some((w) => w.id === workspaceId)) return null
  const ui = useUIStore.getState()
  ui.closePalette()
  ui.leaveSettings()
  if (workspaces.activeWorkspaceId !== workspaceId) workspaces.setActive(workspaceId)
  const key = chatKey(workspaceId)
  const sessionId = useChatStore.getState().current[key]
  const title = (sessionId && useChatStore.getState().meta[sessionId]?.title) || CHAT_PANE_TITLE
  const paneId = useLayoutStore.getState().openChat(workspaceId, title)
  const prompt = opts.prompt?.trim()
  if (prompt && opts.send) {
    void ensureSession(workspaceId).then((id) => {
      nameSession(id, prompt)
      return chatFor(id).sendMessage({
        text: prompt,
        metadata: opts.context?.length
          ? { createdAt: Date.now(), context: opts.context }
          : { createdAt: Date.now() },
      })
    })
  } else if (prompt) {
    useChatStore.getState().setDraft(key, prompt)
  }
  return paneId
}
