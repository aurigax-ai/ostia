import { useChat } from '@ai-sdk/react'
import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { Dict } from '@shared/app/dict'
import type { UIMessage } from 'ai'
import { type MutableRefObject, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useDict } from '@/lib/app/useDict'
import { checkpointFiles } from '@/lib/assist/chatCheckpoint'
import { decodeChatError } from '@/lib/assist/chatTransport'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useChatModel, wakeAssist } from '@/stores/assist/assistStore'
import {
  type ChatNotice,
  chatFor,
  chatKey,
  ensureSession,
  useChatStore,
} from '@/stores/assist/chatStore'
import { useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { retryPendingFocus } from '@/stores/workspaces/surfaceSlotsStore'
import { ChatCheckpointDialog } from './ChatCheckpointDialog'
import { ChatClearDialog } from './ChatClearDialog'
import type { ChatActionNotice } from './ChatCodeActions'
import { ChatComposerArea } from './ChatComposerArea'
import { ChatConversation } from './ChatConversation'
import { ChatHeader, type ChatVariant } from './ChatHeader'
import { markdownComponents } from './ChatMarkdown'
import { ChatReviewBar } from './ChatReviewBar'
import { useChatAsk } from './useChatAsk'
import { useChatComposer } from './useChatComposer'
import { useChatContext } from './useChatContext'
import { useChatFocus } from './useChatFocus'
import { useChatMessageActions } from './useChatMessageActions'
import type { SlashCard } from './useChatSlash'

export interface ChatViewProps {
  workspaceId: string | null
  variant: ChatVariant
  preferSessionId?: string
  seed?: string
  onBack?: () => void
  onInserted?: () => void
  focusRef?: MutableRefObject<HTMLElement | null>
}

export function ChatView(props: ChatViewProps): JSX.Element | null {
  const key = chatKey(props.workspaceId)
  const sessionId = useChatStore((s) => s.current[key])
  const { workspaceId, preferSessionId } = props
  useEffect(() => {
    wakeAssist()
  }, [])
  useEffect(() => {
    void ensureSession(workspaceId, preferSessionId)
  }, [workspaceId, preferSessionId])
  if (!sessionId) return null
  return <ChatSession key={sessionId} sessionId={sessionId} {...props} />
}

type Notice = ChatActionNotice | 'copiedMessage' | ChatNotice | null

function ChatSession({
  sessionId,
  workspaceId,
  variant,
  seed = '',
  onBack,
  onInserted,
  focusRef,
}: ChatViewProps & { sessionId: string }): JSX.Element {
  const d = useDict()
  const key = chatKey(workspaceId)
  const chat = useMemo(() => chatFor(sessionId), [sessionId])
  const chatHelpers = useChat({ chat })
  const { messages, status, error } = chatHelpers
  const session = useChatSessionData(sessionId, key)
  const { provider, historyOn, scratch, sessionNotice, draftSeed, attachments } = session
  const [draft, setDraft] = useState(seed)
  const [notice, setNotice] = useState<Notice>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set())
  const labels = d.ask.context
  const chatContext = useChatContext({ workspaceId, labels })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useFocusRegistration(focusRef, areaRef)
  const rootRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [card, setCard] = useState<SlashCard>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [checkpoint, setCheckpoint] = useState<string | null>(null)
  const checkpoints = useChatCheckpoints(sessionId, messages)
  const shared = { workspaceId, sessionId, draft, setDraft, busy, chat: chatHelpers, setCard }
  const { ask, willRedact } = useChatAsk({
    ...shared,
    chatKey: key,
    labels,
    context: chatContext,
    attachments,
    editing,
    setEditing,
    setNotice,
  })
  const last = messages[messages.length - 1]
  const composer = useChatComposer({
    ...shared,
    d,
    last,
    historyOn,
    scratch,
    provider,
    ask,
    setConfirmClear,
    setSessionsOpen,
    setPicking,
    areaRef,
    rootRef,
  })
  const { slashNotice, setSlashNotice } = composer.slash
  useChatFocus({ areaRef, draftSeed, setDraft, chatKey: key })
  const messageActions = useChatMessageActions({
    ...shared,
    setStopped,
    setEditing,
    setConfirmClear,
    areaRef,
  })
  const markdown = useChatMarkdown({ workspaceId, sessionId, setNotice, onInserted })
  const noticeText = slashNotice ?? noticeTextOf(d, notice ?? sessionNotice)
  return (
    <div
      ref={rootRef}
      className={cn(
        'chat-view relative flex min-h-0 flex-col',
        variant === 'palette' ? 'max-h-[72vh]' : 'h-full bg-bg',
      )}
    >
      <ChatHeader
        variant={variant}
        workspaceId={workspaceId}
        sessionId={sessionId}
        recording={historyOn && !scratch}
        scratch={scratch}
        busy={busy}
        sessionsOpen={sessionsOpen}
        onSessionsOpenChange={setSessionsOpen}
      />
      <ChatReviewBar sessionId={sessionId} />
      <ChatConversation
        variant={variant}
        workspaceId={workspaceId}
        chat={chatHelpers}
        actions={messageActions}
        last={last}
        provider={provider}
        options={chatContext.options}
        markdown={markdown}
        busy={busy}
        stopped={stopped}
        editing={editing}
        checkpoints={checkpoints}
        card={card}
        waiting={busy && (last?.role === 'user' || !hasVisibleContent(last))}
        errorInfo={error ? decodeChatError(error.message) : null}
        ask={ask}
        setNotice={setNotice}
        setCheckpoint={setCheckpoint}
        setCard={setCard}
      />
      <ChatComposerArea
        sessionId={sessionId}
        workspaceId={workspaceId}
        chatKey={key}
        chat={chatHelpers}
        provider={provider}
        busy={busy}
        draft={draft}
        setDraft={setDraft}
        editing={editing}
        setEditing={setEditing}
        areaRef={areaRef}
        noticeText={noticeText}
        composer={composer}
        picking={picking}
        setPicking={setPicking}
        attachments={attachments}
        willRedact={willRedact}
        context={chatContext}
        ask={ask}
        onStop={messageActions.onStop}
        onBack={onBack}
      />
      <ChatCheckpointDialog
        sessionId={sessionId}
        workspaceId={workspaceId}
        messages={messages}
        messageId={checkpoint}
        onClose={() => setCheckpoint(null)}
        onDone={setSlashNotice}
      />
      <ChatClearDialog
        confirmClear={confirmClear}
        setConfirmClear={setConfirmClear}
        messages={messages}
        onClear={messageActions.clearChat}
      />
    </div>
  )
}

function useChatSessionData(sessionId: string, key: string) {
  const modelRef = useChatStore((s) => s.meta[sessionId]?.modelRef)
  const provider = useChatModel(modelRef)
  const historyOn = useSettingsStore((s) => s.assistant.chatHistory)
  const scratch = useChatStore((s) => s.meta[sessionId]?.scratch === true)
  const sessionNotice = useChatStore((s) => s.notice[sessionId] ?? null)
  const draftSeed = useChatStore((s) => s.drafts[key])
  const attachments = useChatStore((s) => s.attachments[key] ?? EMPTY_ATTACHMENTS)
  return { provider, historyOn, scratch, sessionNotice, draftSeed, attachments }
}

function useFocusRegistration(
  focusRef: MutableRefObject<HTMLElement | null> | undefined,
  areaRef: RefObject<HTMLTextAreaElement>,
): void {
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = areaRef.current
    retryPendingFocus()
    return () => {
      focusRef.current = null
    }
  }, [focusRef, areaRef])
}

function noticeTextOf(d: Dict, shown: Notice): string {
  if (!shown) return ''
  return (
    (d.chatActions.notices as Record<string, string>)[shown] ??
    (d.chat.notices as Record<string, string>)[shown] ??
    ''
  )
}

function useChatCheckpoints(sessionId: string, messages: UIMessage[]): Set<string> {
  const editRecords = useChatToolsStore((s) => s.edits)
  return useMemo(() => {
    const records = Object.values(editRecords).filter((e) => e.sessionId === sessionId)
    if (records.length === 0) return new Set<string>()
    return new Set(
      messages
        .filter((m) => m.role === 'user' && checkpointFiles(messages, records, m.id).length > 0)
        .map((m) => m.id),
    )
  }, [editRecords, messages, sessionId])
}

function useChatMarkdown({
  workspaceId,
  sessionId,
  setNotice,
  onInserted,
}: {
  workspaceId: string | null
  sessionId: string
  setNotice: (notice: Notice) => void
  onInserted: (() => void) | undefined
}) {
  return useMemo(
    () =>
      markdownComponents({
        workspaceId,
        sessionId,
        onNotice: setNotice,
        onInserted,
      }),
    [workspaceId, sessionId, setNotice, onInserted],
  )
}

const EMPTY_ATTACHMENTS: ChatContextItem[] = []

export function hasVisibleContent(message: UIMessage | undefined): boolean {
  if (!message) return false
  return message.parts.some(
    (part) =>
      (part.type === 'text' && part.text.trim() !== '') ||
      part.type.startsWith('tool-') ||
      part.type === 'dynamic-tool',
  )
}
