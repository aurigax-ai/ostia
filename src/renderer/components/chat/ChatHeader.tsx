import { ArrowsOutSimpleIcon, NotePencilIcon } from '@phosphor-icons/react'
import { IconButton } from '@/components/common/IconButton'
import { Badge } from '@/components/ui/badge'
import { useDict } from '@/lib/app/useDict'
import { openChatPane } from '@/lib/assist/chatPane'
import { useUIStore } from '@/stores/app/uiStore'
import { startNewSession } from '@/stores/assist/chatStore'
import { ChatSessions } from './ChatSessions'

export type ChatVariant = 'pane' | 'palette'

export function ChatHeader({
  variant,
  workspaceId,
  sessionId,
  recording,
  scratch,
  busy,
  sessionsOpen,
  onSessionsOpenChange,
}: {
  variant: ChatVariant
  workspaceId: string | null
  sessionId: string
  recording: boolean
  scratch: boolean
  busy: boolean
  sessionsOpen: boolean
  onSessionsOpenChange: (open: boolean) => void
}): JSX.Element {
  const d = useDict()
  return (
    <div className="flex min-h-9 items-center gap-1.5 border-line border-b px-2">
      {variant === 'palette' ? (
        <Badge variant="secondary" className="rounded-sm">
          {d.ask.mode}
        </Badge>
      ) : null}
      <span className="ml-auto" />
      <ChatSessions
        workspaceId={workspaceId}
        sessionId={sessionId}
        recording={recording}
        scratch={scratch}
        open={sessionsOpen}
        onOpenChange={onSessionsOpenChange}
      />
      {variant === 'palette' ? (
        <IconButton
          size="bar"
          icon={ArrowsOutSimpleIcon}
          label={d.chat.openInPane}
          onClick={() => {
            useUIStore.getState().closePalette()
            openChatPane(workspaceId ? { workspaceId } : {})
          }}
        />
      ) : null}
      <IconButton
        size="bar"
        icon={NotePencilIcon}
        label={d.chat.newChat}
        disabled={busy}
        onClick={() => startNewSession(workspaceId)}
      />
    </div>
  )
}
