import { useDict } from '@/i18n/useDict'
import { chatKey, useChatStore } from '@/stores/chatStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useEffect } from 'react'
import { ChatView } from './ChatView'

export function ChatPane({
  workspaceId,
  paneId,
  sessionId,
}: {
  workspaceId: string
  paneId: string
  sessionId?: string
}): JSX.Element {
  const d = useDict()
  const current = useChatStore((s) => s.current[chatKey(workspaceId)])
  const title =
    useChatStore((s) => (current ? s.meta[current]?.title : undefined)) || d.chat.paneTitle

  useEffect(() => {
    if (current) useLayoutStore.getState().setChatSession(workspaceId, paneId, current, title)
  }, [workspaceId, paneId, current, title])

  return (
    <div className="chat-pane flex h-full min-h-0 flex-col" data-pane-id={paneId}>
      <ChatView
        workspaceId={workspaceId}
        variant="pane"
        {...(sessionId ? { preferSessionId: sessionId } : {})}
      />
    </div>
  )
}
