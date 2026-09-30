import { cn } from '@/lib/utils'
import { useChat } from '@ai-sdk/react'
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  FolderSimpleIcon,
  type Icon,
  NotePencilIcon,
  RecordIcon,
  SelectionIcon,
  TagIcon,
  TerminalWindowIcon,
  TextAlignLeftIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import type { AssistProviderInfo, ChatContextItem } from '@shared/assist'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import {
  ASK_CONTEXT_ORDER,
  type AskContextKind,
  askContextOptions,
  insertAtPrompt,
  insertTarget,
  isShellLanguage,
} from '../lib/askContext'
import { openChatPane } from '../lib/chatPane'
import { type PineChatMessage, decodeChatError, messageText } from '../lib/chatTransport'
import { useAssistProvider } from '../stores/assistStore'
import { useBlocksStore } from '../stores/blocksStore'
import {
  type ChatNotice,
  chatFor,
  chatKey,
  ensureSession,
  nameSession,
  startNewSession,
  useChatStore,
} from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { ChatSessions } from './ChatSessions'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockHeader,
  CodeBlockTitle,
} from './ai-elements/code-block'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from './ai-elements/conversation'
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from './ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from './ai-elements/prompt-input'
import { Suggestion, Suggestions } from './ai-elements/suggestion'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const CONTEXT_ICONS: Record<AskContextKind, Icon> = {
  cwd: FolderSimpleIcon,
  output: TextAlignLeftIcon,
  selection: SelectionIcon,
  pane: TagIcon,
}

export type ChatVariant = 'pane' | 'palette'

export interface ChatViewProps {
  workspaceId: string | null
  variant: ChatVariant
  preferSessionId?: string
  seed?: string
  onBack?: () => void
  onInserted?: () => void
}

export function ChatView(props: ChatViewProps): JSX.Element | null {
  const key = chatKey(props.workspaceId)
  const sessionId = useChatStore((s) => s.current[key])
  const { workspaceId, preferSessionId } = props
  useEffect(() => {
    void ensureSession(workspaceId, preferSessionId)
  }, [workspaceId, preferSessionId])
  if (!sessionId) return null
  return <ChatSession key={sessionId} sessionId={sessionId} {...props} />
}

type Notice = 'inserted' | 'copiedInstead' | ChatNotice | null

function ChatSession({
  sessionId,
  workspaceId,
  variant,
  seed = '',
  onBack,
  onInserted,
}: ChatViewProps & { sessionId: string }): JSX.Element {
  const d = useDict()
  const chat = useMemo(() => chatFor(sessionId), [sessionId])
  const { messages, sendMessage, status, stop, regenerate, error, clearError } = useChat({ chat })
  const provider = useAssistProvider('chat')
  const recording = useSettingsStore((s) => s.assistant.chatHistory)
  const sessionNotice = useChatStore((s) => s.notice[sessionId] ?? null)
  const draftSeed = useChatStore((s) => s.drafts[chatKey(workspaceId)])
  const [draft, setDraft] = useState(seed)
  const [notice, setNotice] = useState<Notice>(null)
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set())
  const labels = d.ask.context
  const [options, setOptions] = useState(() => askContextOptions(labels))
  const [enabled, setEnabled] = useState<ReadonlySet<AskContextKind>>(
    () => new Set(options.cwd ? (['cwd'] as const) : []),
  )
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [])

  useEffect(() => {
    if (!draftSeed) return
    setDraft(draftSeed)
    useChatStore.getState().takeDraft(chatKey(workspaceId))
    areaRef.current?.focus()
  }, [draftSeed, workspaceId])

  const toggle = (kind: AskContextKind): void =>
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const ask = (text: string, extra: ChatContextItem[] = []): void => {
    const question = text.trim()
    if (!question || busy) return
    const fresh = askContextOptions(labels)
    setOptions(fresh)
    const context = [
      ...extra,
      ...ASK_CONTEXT_ORDER.filter((kind) => enabled.has(kind))
        .map((kind) => fresh[kind])
        .filter((item): item is ChatContextItem => item !== undefined),
    ]
    setDraft('')
    setNotice(null)
    clearError()
    nameSession(sessionId, question)
    void sendMessage({
      text: question,
      metadata: context.length > 0 ? { createdAt: Date.now(), context } : { createdAt: Date.now() },
    })
  }

  const insert = (code: string): void => {
    void insertAtPrompt(code, workspaceId).then((outcome) => {
      if (outcome === 'inserted') {
        setNotice('inserted')
        onInserted?.()
      } else setNotice('copiedInstead')
    })
  }

  const onStop = (): void => {
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') setStopped((prev) => new Set(prev).add(last.id))
    void stop()
  }

  const available = ASK_CONTEXT_ORDER.filter((kind) => options[kind])
  const last = messages[messages.length - 1]
  const waiting = busy && last?.role === 'user'
  const errorInfo = error ? decodeChatError(error.message) : null
  const shownNotice = notice ?? sessionNotice

  return (
    <div
      className={cn(
        'chat-view flex min-h-0 flex-col',
        variant === 'palette' ? 'max-h-[72vh]' : 'h-full bg-bg',
      )}
    >
      <ChatHeader
        variant={variant}
        workspaceId={workspaceId}
        sessionId={sessionId}
        provider={provider}
        recording={recording}
        busy={busy}
      />
      <Conversation className={variant === 'palette' ? 'max-h-[48vh]' : undefined}>
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              title={fmt(d.ask.emptyTitle, { name: provider?.name ?? d.chat.paneTitle })}
              description={
                provider
                  ? fmt(d.ask.emptyBody, { model: provider.label ?? provider.name })
                  : d.chat.noProvider
              }
            >
              {options.output && provider ? (
                <Suggestions className="mt-3">
                  <Suggestion
                    suggestion={d.chat.explainOutputPrompt}
                    onClick={(text) => (options.output ? ask(text, [options.output]) : undefined)}
                  >
                    {d.chat.explainOutput}
                  </Suggestion>
                </Suggestions>
              ) : null}
            </ConversationEmptyState>
          ) : (
            messages.map((message) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                workspaceId={workspaceId}
                streaming={busy && message === last}
                stopped={stopped.has(message.id)}
                onInsert={insert}
                onRegenerate={
                  message === last && message.role === 'assistant' && !busy
                    ? () => {
                        clearError()
                        void regenerate()
                      }
                    : undefined
                }
              />
            ))
          )}
          {waiting ? (
            <p className="px-0.5 text-fg-muted text-ui-base" aria-live="polite">
              {d.ask.thinking}
            </p>
          ) : null}
          {errorInfo ? (
            <p role="alert" className="flex items-start gap-1.5 text-attn-fg text-ui-sm">
              <WarningCircleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {[d.ask.errors[errorInfo.code] ?? d.ask.errors.failed, errorInfo.message]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            </p>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton label={d.chat.scrollDown} />
      </Conversation>
      <PromptInput className="border-line border-t p-2" onSubmit={(message) => ask(message.text)}>
        {available.length > 0 ? (
          <PromptInputHeader>
            <fieldset aria-label={d.ask.contextGroup} className="flex min-w-0 flex-wrap gap-1">
              {available.map((kind) => {
                const IconFor = CONTEXT_ICONS[kind]
                const on = enabled.has(kind)
                return (
                  <Button
                    key={kind}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={on}
                    onClick={() => toggle(kind)}
                    className="ask-chip"
                  >
                    <IconFor />
                    <span>{labels[kind]}</span>
                    {kind === 'cwd' && options.cwd ? (
                      <span className="max-w-48 truncate font-mono text-ui-xs">
                        {options.cwd.text}
                      </span>
                    ) : null}
                  </Button>
                )
              })}
            </fieldset>
          </PromptInputHeader>
        ) : null}
        <PromptInputBody>
          <PromptInputTextarea
            ref={areaRef}
            value={draft}
            aria-label={d.ask.question}
            placeholder={d.ask.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return
              e.stopPropagation()
              if (e.key === 'Backspace' && draft === '' && messages.length === 0 && onBack) {
                e.preventDefault()
                onBack()
              }
            }}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <p aria-live="polite" className="truncate px-1 text-fg-muted text-ui-xs empty:hidden">
              {shownNotice ? d.chat.notices[shownNotice] : ''}
            </p>
          </PromptInputTools>
          <PromptInputSubmit
            status={status}
            onStop={onStop}
            disabled={!busy && (!draft.trim() || !provider)}
            submitLabel={d.ask.send}
            stopLabel={d.ask.stop}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}

function ChatHeader({
  variant,
  workspaceId,
  sessionId,
  provider,
  recording,
  busy,
}: {
  variant: ChatVariant
  workspaceId: string | null
  sessionId: string
  provider: AssistProviderInfo | null
  recording: boolean
  busy: boolean
}): JSX.Element {
  const d = useDict()
  const changeModel = (): void => {
    const extId = provider?.extId
    const open = extId ? `${extId}.open` : null
    useUIStore.getState().closePalette()
    if (open && commands.has(open)) void commands.exec(open)
    else useUIStore.getState().openSettingsAt('plugins')
  }
  return (
    <div className="flex min-h-9 items-center gap-1.5 border-line border-b px-2">
      {variant === 'palette' ? (
        <Badge variant="secondary" className="rounded-sm">
          {d.ask.mode}
        </Badge>
      ) : null}
      <ChatSessions workspaceId={workspaceId} sessionId={sessionId} />
      <Hint label={recording ? d.chat.recordingHint : d.chat.notRecordingHint}>
        <span
          className={cn(
            'chat-recording flex shrink-0 items-center gap-1 text-ui-xs',
            recording ? 'text-fg' : 'text-fg-muted',
          )}
          data-recording={recording || undefined}
        >
          <RecordIcon className="size-3" />
          {recording ? d.chat.recording : d.chat.notRecording}
        </span>
      </Hint>
      <span className="ml-auto flex min-w-0 items-center gap-1 text-fg-muted text-ui-xs">
        {provider ? (
          <>
            <span className="truncate" title={d.chat.model}>
              {provider.label ?? provider.name}
            </span>
            <Button variant="link" size="xs" className="h-5 px-1 text-ui-xs" onClick={changeModel}>
              {d.chat.change}
            </Button>
          </>
        ) : null}
      </span>
      {variant === 'palette' ? (
        <IconButton
          size="bar"
          icon={ArrowSquareOutIcon}
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

function ChatMessageRow({
  message,
  workspaceId,
  streaming,
  stopped,
  onInsert,
  onRegenerate,
}: {
  message: PineChatMessage
  workspaceId: string | null
  streaming: boolean
  stopped: boolean
  onInsert: (code: string) => void
  onRegenerate?: () => void
}): JSX.Element {
  const d = useDict()
  const text = messageText(message)
  const components = useMemo(
    () => markdownComponents(onInsert, workspaceId),
    [onInsert, workspaceId],
  )
  if (message.role === 'user') {
    const context = message.metadata?.context ?? []
    return (
      <Message from="user" aria-label={d.ask.question}>
        <MessageContent>
          <p className="whitespace-pre-wrap text-fg text-ui-base">{text}</p>
        </MessageContent>
        {context.length > 0 ? (
          <p className="px-2.5 text-fg-muted text-ui-xs">
            {fmt(d.ask.sentWith, { items: context.map((c) => c.label).join(', ') })}
          </p>
        ) : null}
      </Message>
    )
  }
  return (
    <Message
      from="assistant"
      className="ask-answer"
      aria-label={d.ask.answer}
      aria-busy={streaming}
    >
      <MessageContent>
        {text ? <MessageResponse components={components}>{text}</MessageResponse> : null}
      </MessageContent>
      {stopped ? <p className="text-fg-muted text-ui-xs">{d.ask.stopped}</p> : null}
      {onRegenerate ? (
        <MessageActions>
          {text ? <CopyAction text={text} /> : null}
          <MessageAction tooltip={d.ask.regenerate} onClick={onRegenerate}>
            <ArrowCounterClockwiseIcon />
          </MessageAction>
        </MessageActions>
      ) : null}
    </Message>
  )
}

function CopyAction({ text }: { text: string }): JSX.Element {
  const d = useDict()
  const [copied, setCopied] = useCopied()
  return (
    <MessageAction
      tooltip={copied ? d.ask.copied : d.ask.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(setCopied, () => undefined)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  )
}

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, () => setCopied(true)]
}

interface HastLike {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

function hastText(node: HastLike): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

export function codeLanguage(node: HastLike | undefined): string {
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const list = Array.isArray(classes) ? classes.map(String) : []
  const match = list.find((c) => c.startsWith('language-'))
  return match ? match.slice('language-'.length) : ''
}

function markdownComponents(
  onInsert: (code: string) => void,
  workspaceId: string | null,
): Components {
  return {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    table: ({ node: _node, ...props }) => (
      <div className="typeset-scroll">
        <table {...props} />
      </div>
    ),
    pre: ({ node }) => {
      const hast = node as HastLike | undefined
      const code = hast ? hastText(hast).replace(/\n$/, '') : ''
      const language = codeLanguage(hast)
      return (
        <CodeBlock code={code} language={language} className="not-typeset">
          <CodeBlockHeader>
            <CodeBlockTitle className="font-mono text-fg-muted text-ui-xs">
              {language}
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeCopy code={code} />
              {isShellLanguage(language) ? (
                <InsertButton code={code} workspaceId={workspaceId} onInsert={onInsert} />
              ) : null}
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      )
    },
  }
}

function CodeCopy({ code }: { code: string }): JSX.Element {
  const d = useDict()
  const [copied, setCopied] = useCopied()
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? d.ask.copied : d.ask.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(setCopied, () => undefined)
      }}
    />
  )
}

function InsertButton({
  code,
  workspaceId,
  onInsert,
}: {
  code: string
  workspaceId: string | null
  onInsert: (code: string) => void
}): JSX.Element {
  const d = useDict()
  const reason = useBlocksStore((s): string | null => {
    const target = insertTarget(workspaceId, s)
    if (!target) return d.chat.insertNoTerminal
    return target.idle ? null : d.chat.insertBusy
  })
  const reasonId = useId()
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-disabled={reason !== null}
      aria-describedby={reason ? reasonId : undefined}
      className="aria-disabled:opacity-50"
      onClick={() => {
        if (reason === null) onInsert(code)
      }}
    >
      <TerminalWindowIcon />
      {d.ask.insert}
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
    </Button>
  )
  return reason ? <Hint label={reason}>{button}</Hint> : button
}
