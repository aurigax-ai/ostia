import { useEffect, useRef } from 'react'
import { useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { chatKey, useChatStore } from '@/stores/assist/chatStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
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
  const composerRef = useRef<HTMLElement | null>(null)
  useSurfaceFocus(paneId, () => composerRef.current)
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
        focusRef={composerRef}
        {...(sessionId ? { preferSessionId: sessionId } : {})}
      />
    </div>
  )
}
