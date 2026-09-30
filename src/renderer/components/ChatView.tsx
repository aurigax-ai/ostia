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
  PencilSimpleIcon,
  QuotesIcon,
  RecordIcon,
  SelectionIcon,
  TagIcon,
  TerminalWindowIcon,
  TextAlignLeftIcon,
  TextTIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import type { AssistProviderInfo, ChatContextItem } from '@shared/assist'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import {
  ASK_CONTEXT_ORDER,
  type AskContextKind,
  askContextOptions,
  isShellLanguage,
} from '../lib/askContext'
import { insertInto, looksLikeCommand } from '../lib/chatActions'
import { fileLinkOf, isWebUrl, rehypeFileLinks, wholeFileLink } from '../lib/chatLinks'
import type { FileLinkTarget } from '../lib/chatLinks'
import { openChatPane } from '../lib/chatPane'
import { type PineChatMessage, decodeChatError, messageText } from '../lib/chatTransport'
import { resolveLinkPath } from '../lib/fileLinks'
import { openFileAt } from '../lib/openFile'
import { openSidebarUrl } from '../lib/sidebarItems'
import { useAssistProvider } from '../stores/assistStore'
import {
  type ChatNotice,
  chatFor,
  chatKey,
  ensureSession,
  nameSession,
  saveSession,
  startNewSession,
  useChatStore,
} from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import {
  type ChatActionNotice,
  ChatCodeActions,
  insertReason,
  useCopied,
  useTerminals,
} from './ChatCodeActions'
import { AttachmentChips, ChatContextPicker } from './ChatContextPicker'
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

const REHYPE_PLUGINS = [rehypeFileLinks]

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

type Notice = ChatActionNotice | 'copiedMessage' | ChatNotice | null

export function quoteText(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`
}

function focusAtEnd(area: HTMLTextAreaElement | null): void {
  if (!area) return
  area.focus()
  area.setSelectionRange(area.value.length, area.value.length)
}

function ChatSession({
  sessionId,
  workspaceId,
  variant,
  seed = '',
  onBack,
  onInserted,
}: ChatViewProps & { sessionId: string }): JSX.Element {
  const d = useDict()
  const key = chatKey(workspaceId)
  const chat = useMemo(() => chatFor(sessionId), [sessionId])
  const { messages, sendMessage, setMessages, status, stop, regenerate, error, clearError } =
    useChat({ chat })
  const provider = useAssistProvider('chat')
  const recording = useSettingsStore((s) => s.assistant.chatHistory)
  const sessionNotice = useChatStore((s) => s.notice[sessionId] ?? null)
  const draftSeed = useChatStore((s) => s.drafts[key])
  const attachments = useChatStore((s) => s.attachments[key] ?? EMPTY_ATTACHMENTS)
  const [draft, setDraft] = useState(seed)
  const [notice, setNotice] = useState<Notice>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set())
  const labels = d.ask.context
  const [options, setOptions] = useState(() => askContextOptions(labels))
  const [enabled, setEnabled] = useState<ReadonlySet<AskContextKind>>(
    () => new Set(options.cwd ? (['cwd'] as const) : []),
  )
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    focusAtEnd(areaRef.current)
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body) focusAtEnd(areaRef.current)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    if (!draftSeed) return
    setDraft(draftSeed)
    useChatStore.getState().takeDraft(key)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }, [draftSeed, key])

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
      ...attachments,
      ...ASK_CONTEXT_ORDER.filter((kind) => enabled.has(kind))
        .map((kind) => fresh[kind])
        .filter((item): item is ChatContextItem => item !== undefined),
    ]
    if (editing) {
      const at = messages.findIndex((m) => m.id === editing)
      if (at >= 0) setMessages(messages.slice(0, at))
      setEditing(null)
    }
    setDraft('')
    setNotice(null)
    clearError()
    useChatStore.getState().clearAttachments(key)
    nameSession(sessionId, question)
    void sendMessage({
      text: question,
      metadata: context.length > 0 ? { createdAt: Date.now(), context } : { createdAt: Date.now() },
    })
  }

  const onStop = (): void => {
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') setStopped((prev) => new Set(prev).add(last.id))
    void stop()
  }

  const deleteMessage = (id: string): void => {
    setMessages(messages.filter((m) => m.id !== id))
    void saveSession(sessionId)
  }

  const startEdit = (message: PineChatMessage): void => {
    setEditing(message.id)
    setDraft(messageText(message))
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }

  const quote = (text: string): void => {
    setDraft((prev) => `${quoteText(text)}${prev}`)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }

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

  const available = ASK_CONTEXT_ORDER.filter((kind) => options[kind])
  const last = messages[messages.length - 1]
  const waiting = busy && last?.role === 'user'
  const errorInfo = error ? decodeChatError(error.message) : null
  const shownNotice = notice ?? sessionNotice
  const noticeText = shownNotice
    ? ((d.chatActions.notices as Record<string, string>)[shownNotice] ??
      (d.chat.notices as Record<string, string>)[shownNotice] ??
      '')
    : ''

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
                components={markdown}
                streaming={busy && message === last}
                stopped={stopped.has(message.id)}
                editing={editing === message.id}
                busy={busy}
                onCopied={() => setNotice('copiedMessage')}
                onQuote={quote}
                onEdit={startEdit}
                onDelete={deleteMessage}
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
        <PromptInputHeader>
          <ChatContextPicker
            workspaceId={workspaceId}
            open={picking}
            onOpenChange={(open) => {
              setPicking(open)
              if (!open) requestAnimationFrame(() => focusAtEnd(areaRef.current))
            }}
            onAttach={(item) => useChatStore.getState().attach(key, item)}
          />
          {available.length > 0 ? (
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
          ) : null}
          <AttachmentChips
            items={attachments}
            onRemove={(index) => useChatStore.getState().detach(key, index)}
          />
        </PromptInputHeader>
        <PromptInputBody>
          <PromptInputTextarea
            ref={areaRef}
            value={draft}
            aria-label={d.ask.question}
            placeholder={d.ask.placeholder}
            onChange={(e) => {
              const next = e.target.value
              const caret = e.target.selectionStart
              if (opensPicker(next, caret)) {
                setDraft(next.slice(0, caret - 1) + next.slice(caret))
                setPicking(true)
                return
              }
              setDraft(next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (editing) {
                  e.preventDefault()
                  e.stopPropagation()
                  setEditing(null)
                  setDraft('')
                }
                return
              }
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
            {editing ? (
              <span className="flex min-w-0 items-center gap-1 px-1 text-fg-muted text-ui-xs">
                <span className="truncate">{d.chatActions.editing}</span>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-5 px-1 text-ui-xs"
                  onClick={() => {
                    setEditing(null)
                    setDraft('')
                  }}
                >
                  {d.chatActions.cancelEdit}
                </Button>
              </span>
            ) : (
              <p aria-live="polite" className="truncate px-1 text-fg-muted text-ui-xs empty:hidden">
                {noticeText}
              </p>
            )}
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

const EMPTY_ATTACHMENTS: ChatContextItem[] = []

export function opensPicker(text: string, caret: number): boolean {
  if (caret < 1 || text[caret - 1] !== '@') return false
  const before = caret >= 2 ? text[caret - 2] : ''
  return before === '' || /\s/.test(before)
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
  components,
  streaming,
  stopped,
  editing,
  busy,
  onCopied,
  onQuote,
  onEdit,
  onDelete,
  onRegenerate,
}: {
  message: PineChatMessage
  components: Components
  streaming: boolean
  stopped: boolean
  editing: boolean
  busy: boolean
  onCopied: () => void
  onQuote: (text: string) => void
  onEdit: (message: PineChatMessage) => void
  onDelete: (id: string) => void
  onRegenerate?: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatActions
  const text = messageText(message)
  const contentRef = useRef<HTMLDivElement>(null)
  const copyPlain = (): void => {
    const plain = contentRef.current?.innerText ?? text
    void navigator.clipboard?.writeText(plain.trim()).then(onCopied, () => undefined)
  }
  const common = (
    <>
      <CopyMessageAction text={text} label={t.copyMarkdown} />
      <MessageAction tooltip={t.copyText} onClick={copyPlain}>
        <TextTIcon />
      </MessageAction>
      <MessageAction tooltip={t.quote} onClick={() => onQuote(text)}>
        <QuotesIcon />
      </MessageAction>
    </>
  )
  if (message.role === 'user') {
    const context = message.metadata?.context ?? []
    return (
      <Message
        from="user"
        aria-label={d.ask.question}
        data-editing={editing || undefined}
        className="chat-message"
      >
        <MessageContent>
          <div ref={contentRef}>
            <p className="whitespace-pre-wrap text-fg text-ui-base">{text}</p>
          </div>
        </MessageContent>
        {context.length > 0 ? (
          <p className="px-2.5 text-fg-muted text-ui-xs">
            {fmt(d.ask.sentWith, { items: context.map((c) => c.label).join(', ') })}
          </p>
        ) : null}
        <MessageActions className="chat-message-actions">
          {common}
          <MessageAction tooltip={t.edit} disabled={busy} onClick={() => onEdit(message)}>
            <PencilSimpleIcon />
          </MessageAction>
          <MessageAction
            tooltip={t.deleteMessage}
            disabled={busy}
            onClick={() => onDelete(message.id)}
          >
            <TrashIcon />
          </MessageAction>
        </MessageActions>
      </Message>
    )
  }
  return (
    <Message
      from="assistant"
      className="ask-answer chat-message"
      aria-label={d.ask.answer}
      aria-busy={streaming}
    >
      <MessageContent>
        {text ? (
          <div ref={contentRef}>
            <MessageResponse components={components} rehypePlugins={REHYPE_PLUGINS}>
              {text}
            </MessageResponse>
          </div>
        ) : null}
      </MessageContent>
      {stopped ? <p className="text-fg-muted text-ui-xs">{d.ask.stopped}</p> : null}
      {!streaming && text ? (
        <MessageActions className="chat-message-actions">
          {common}
          {onRegenerate ? (
            <MessageAction tooltip={d.ask.regenerate} onClick={onRegenerate}>
              <ArrowCounterClockwiseIcon />
            </MessageAction>
          ) : null}
          <MessageAction
            tooltip={t.deleteMessage}
            disabled={busy}
            onClick={() => onDelete(message.id)}
          >
            <TrashIcon />
          </MessageAction>
        </MessageActions>
      ) : null}
    </Message>
  )
}

function CopyMessageAction({ text, label }: { text: string; label: string }): JSX.Element {
  const d = useDict()
  const [copied, setCopied] = useCopied()
  return (
    <MessageAction
      tooltip={copied ? d.ask.copied : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(setCopied, () => undefined)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  )
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

interface MarkdownContext {
  workspaceId: string | null
  sessionId: string
  onNotice: (notice: ChatActionNotice) => void
  onInserted?: () => void
}

function workspaceRoot(workspaceId: string | null): string {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState()
  return workspaces.find((w) => w.id === (workspaceId ?? activeWorkspaceId))?.workDir ?? '~'
}

export function openFileLink(target: FileLinkTarget, workspaceId: string | null): void {
  useUIStore.getState().closePalette()
  openFileAt(resolveLinkPath(target.path, workspaceRoot(workspaceId)), target.line, target.column)
}

function FileLink({
  target,
  workspaceId,
  children,
}: {
  target: FileLinkTarget
  workspaceId: string | null
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  return (
    <button
      type="button"
      className="chat-file-link"
      title={fmt(d.chatActions.openFile, { path: target.path })}
      onClick={() => openFileLink(target, workspaceId)}
    >
      {children}
    </button>
  )
}

function InlineCommand({
  command,
  ctx,
  children,
}: {
  command: string
  ctx: MarkdownContext
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  const terminals = useTerminals(ctx.workspaceId)
  const reason = insertReason(d, terminals)
  const target = terminals.find((t) => t.idle)
  return (
    <span className="chat-inline-command">
      <code>{children}</code>
      <IconButton
        icon={TerminalWindowIcon}
        label={reason ? `${d.ask.insert} (${reason})` : d.ask.insert}
        aria-disabled={reason !== null}
        className="chat-inline-insert aria-disabled:opacity-50"
        onClick={() => {
          if (!target) return
          if (insertInto(target.paneId, command)) {
            ctx.onNotice('inserted')
            ctx.onInserted?.()
          }
        }}
      />
    </span>
  )
}

function markdownComponents(ctx: MarkdownContext): Components {
  return {
    a: ({ node: _node, href, children, ...props }) => {
      const file = fileLinkOf(props as Record<string, unknown>)
      if (file) {
        return (
          <FileLink target={file} workspaceId={ctx.workspaceId}>
            {children}
          </FileLink>
        )
      }
      if (isWebUrl(href)) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              useUIStore.getState().closePalette()
              openSidebarUrl(ctx.workspaceId ?? undefined, href)
            }}
          >
            {children}
          </a>
        )
      }
      return <span>{children}</span>
    },
    code: ({ node: _node, children, className, ...props }) => {
      const text = typeof children === 'string' ? children : ''
      const file = text ? wholeFileLink(text) : null
      if (file) {
        return (
          <FileLink target={file} workspaceId={ctx.workspaceId}>
            <code>{children}</code>
          </FileLink>
        )
      }
      if (text && looksLikeCommand(text)) {
        return (
          <InlineCommand command={text} ctx={ctx}>
            {children}
          </InlineCommand>
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
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
            <CodeBlockActions className="code-block-actions">
              <ChatCodeActions
                code={code}
                language={language}
                shell={isShellLanguage(language)}
                sessionId={ctx.sessionId}
                workspaceId={ctx.workspaceId}
                onNotice={ctx.onNotice}
                onInserted={ctx.onInserted}
              />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      )
    },
  }
}
