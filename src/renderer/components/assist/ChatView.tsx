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
import { useChat } from '@ai-sdk/react'
import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { UIMessage } from 'ai'
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import { ChatCheckpointDialog } from './ChatCheckpointDialog'
import { ChatClearDialog } from './ChatClearDialog'
import type { ChatActionNotice } from './ChatCodeActions'
import { ChatComposer } from './ChatComposer'
import { ChatConversation } from './ChatConversation'
import { ChatHeader, type ChatVariant } from './ChatHeader'
import { markdownComponents } from './ChatMarkdown'
import { ChatReviewBar } from './ChatReviewBar'
import { ChatSlashMenu } from './ChatSlashMenu'
import { useChatAsk } from './useChatAsk'
import { useChatContext } from './useChatContext'
import { useChatFocus } from './useChatFocus'
import { useChatMessageActions } from './useChatMessageActions'
import { type SlashCard, useChatSlash } from './useChatSlash'

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
  const modelRef = useChatStore((s) => s.meta[sessionId]?.modelRef)
  const provider = useChatModel(modelRef)
  const historyOn = useSettingsStore((s) => s.assistant.chatHistory)
  const scratch = useChatStore((s) => s.meta[sessionId]?.scratch === true)
  const sessionNotice = useChatStore((s) => s.notice[sessionId] ?? null)
  const draftSeed = useChatStore((s) => s.drafts[key])
  const attachments = useChatStore((s) => s.attachments[key] ?? EMPTY_ATTACHMENTS)
  const [draft, setDraft] = useState(seed)
  const [notice, setNotice] = useState<Notice>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set())
  const labels = d.ask.context
  const chatContext = useChatContext({ workspaceId, labels })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = areaRef.current
    retryPendingFocus()
    return () => {
      focusRef.current = null
    }
  }, [focusRef])
  const rootRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [card, setCard] = useState<SlashCard>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [checkpoint, setCheckpoint] = useState<string | null>(null)
  const editRecords = useChatToolsStore((s) => s.edits)
  const checkpoints = useMemo(() => {
    const records = Object.values(editRecords).filter((e) => e.sessionId === sessionId)
    if (records.length === 0) return new Set<string>()
    return new Set(
      messages
        .filter((m) => m.role === 'user' && checkpointFiles(messages, records, m.id).length > 0)
        .map((m) => m.id),
    )
  }, [editRecords, messages, sessionId])

  const { ask, willRedact } = useChatAsk({
    workspaceId,
    sessionId,
    chatKey: key,
    labels,
    context: chatContext,
    attachments,
    draft,
    setDraft,
    busy,
    editing,
    setEditing,
    chat: chatHelpers,
    setNotice,
    setCard,
  })
  const last = messages[messages.length - 1]
  const chatSlash = useChatSlash({
    d,
    workspaceId,
    sessionId,
    draft,
    setDraft,
    focused,
    busy,
    chat: chatHelpers,
    last,
    historyOn,
    scratch,
    provider,
    ask,
    setConfirmClear,
    setSessionsOpen,
    setPickerQuery,
    setPicking,
    setToolsOpen,
    setModelOpen,
    setCard,
    areaRef,
    rootRef,
  })
  const { menu, rows, active, anchor, setSlashKey, pickRow, slashNotice, setSlashNotice } =
    chatSlash
  useChatFocus({ areaRef, draftSeed, setDraft, chatKey: key })
  const messageActions = useChatMessageActions({
    sessionId,
    chat: chatHelpers,
    setStopped,
    setEditing,
    setDraft,
    setConfirmClear,
    setCard,
    areaRef,
  })

  const markdown = useMemo(
    () =>
      markdownComponents({
        workspaceId,
        sessionId,
        onNotice: setNotice,
        onInserted,
      }),
    [workspaceId, sessionId, onInserted],
  )

  const waiting = busy && (last?.role === 'user' || !hasVisibleContent(last))
  const errorInfo = error ? decodeChatError(error.message) : null
  const shownNotice = notice ?? sessionNotice
  const noticeText =
    slashNotice ??
    (shownNotice
      ? ((d.chatActions.notices as Record<string, string>)[shownNotice] ??
        (d.chat.notices as Record<string, string>)[shownNotice] ??
        '')
      : '')

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
        waiting={waiting}
        errorInfo={errorInfo}
        ask={ask}
        setNotice={setNotice}
        setCheckpoint={setCheckpoint}
        setCard={setCard}
      />
      <ChatComposer
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
        toolsOpen={toolsOpen}
        setToolsOpen={setToolsOpen}
        modelOpen={modelOpen}
        setModelOpen={setModelOpen}
        setFocused={setFocused}
        picking={picking}
        setPicking={setPicking}
        pickerQuery={pickerQuery}
        setPickerQuery={setPickerQuery}
        attachments={attachments}
        willRedact={willRedact}
        context={chatContext}
        slash={chatSlash}
        ask={ask}
        onStop={messageActions.onStop}
        onBack={onBack}
      />
      {menu ? (
        <ChatSlashMenu
          menu={menu}
          rows={rows}
          activeKey={active?.key}
          anchor={anchor}
          areaRef={areaRef}
          onActive={setSlashKey}
          onPick={(row) => pickRow(row, false)}
        />
      ) : null}
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
