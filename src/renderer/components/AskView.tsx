import { cn } from '@/lib/utils'
import {
  ArrowCounterClockwiseIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  FolderSimpleIcon,
  type Icon,
  SelectionIcon,
  StopIcon,
  TagIcon,
  TerminalWindowIcon,
  TextAlignLeftIcon,
  TrashIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import type { AssistProviderInfo, ChatContextItem } from '@shared/assist'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fmt, useDict } from '../i18n/useDict'
import {
  ASK_CONTEXT_ORDER,
  type AskContextKind,
  askContextOptions,
  insertAtPrompt,
  isShellLanguage,
} from '../lib/askContext'
import {
  type AskAnswerTurn,
  type AskTurn,
  type AskUserTurn,
  askKey,
  isStreaming,
  useAskStore,
} from '../stores/askStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

const CONTEXT_ICONS: Record<AskContextKind, Icon> = {
  cwd: FolderSimpleIcon,
  output: TextAlignLeftIcon,
  selection: SelectionIcon,
  pane: TagIcon,
}

const EMPTY_TURNS: AskTurn[] = []

type Notice = 'inserted' | 'copiedInstead' | null

export function AskView({
  provider,
  seed,
  onBack,
  onInserted,
}: {
  provider: AssistProviderInfo
  seed: string
  onBack: () => void
  onInserted: () => void
}): JSX.Element {
  const d = useDict()
  const key = askKey(useWorkspacesStore((s) => s.activeWorkspaceId))
  const turns = useAskStore((s) => s.byWorkspace[key] ?? EMPTY_TURNS)
  const streaming = isStreaming(turns)
  const [draft, setDraft] = useState(seed)
  const [notice, setNotice] = useState<Notice>(null)
  const labels = d.ask.context
  const options = useMemo(() => askContextOptions(labels), [labels])
  const [enabled, setEnabled] = useState<ReadonlySet<AskContextKind>>(
    () => new Set(options.cwd ? (['cwd'] as const) : []),
  )
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  }, [])

  const toggle = (kind: AskContextKind): void =>
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  const send = (): void => {
    const text = draft.trim()
    if (!text || streaming) return
    const fresh = askContextOptions(labels)
    const context = ASK_CONTEXT_ORDER.filter((kind) => enabled.has(kind))
      .map((kind) => fresh[kind])
      .filter((item): item is ChatContextItem => item !== undefined)
    setDraft('')
    setNotice(null)
    void useAskStore.getState().send(key, text, context)
  }

  const insert = (code: string): void => {
    void insertAtPrompt(code).then((outcome) => {
      if (outcome === 'inserted') onInserted()
      else setNotice('copiedInstead')
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') return
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Backspace' && draft === '' && turns.length === 0) {
      e.preventDefault()
      onBack()
    }
  }

  const available = ASK_CONTEXT_ORDER.filter((kind) => options[kind])

  return (
    <div className="ask-view flex max-h-[72vh] min-h-0 flex-col">
      <div className="flex items-start gap-2 px-2 pt-2">
        <Badge variant="secondary" className="mt-1 rounded-sm">
          {d.ask.mode}
        </Badge>
        <Textarea
          ref={areaRef}
          rows={1}
          value={draft}
          aria-label={d.ask.question}
          placeholder={d.ask.placeholder}
          className="max-h-40 min-h-7 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-ui-base shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <IconButton
            size="bar"
            icon={StopIcon}
            label={d.ask.stop}
            onClick={() => useAskStore.getState().stop(key)}
          />
        ) : (
          <IconButton
            size="bar"
            icon={ArrowUpIcon}
            label={d.ask.send}
            disabled={!draft.trim()}
            onClick={send}
          />
        )}
      </div>
      <div className="flex min-h-7 items-center gap-1 border-line border-b px-2 pb-1.5">
        {available.length > 0 ? (
          <fieldset aria-label={d.ask.contextGroup} className="flex min-w-0 flex-wrap gap-1">
            {available.map((kind) => {
              const IconFor = CONTEXT_ICONS[kind]
              const on = enabled.has(kind)
              return (
                <Button
                  key={kind}
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
        <span className="ml-auto truncate pl-2 text-fg-muted text-ui-xs">
          {provider.label ?? provider.name}
        </span>
        {turns.length > 0 ? (
          <IconButton
            icon={TrashIcon}
            label={d.ask.clear}
            onClick={() => useAskStore.getState().clear(key)}
          />
        ) : null}
      </div>
      <Conversation
        turns={turns}
        provider={provider}
        onInsert={insert}
        onRegenerate={() => void useAskStore.getState().regenerate(key)}
      />
      <p
        aria-live="polite"
        className="empty:hidden border-line border-t px-3 py-1.5 text-fg-muted text-ui-xs"
      >
        {notice ? d.ask[notice] : ''}
      </p>
    </div>
  )
}

function Conversation({
  turns,
  provider,
  onInsert,
  onRegenerate,
}: {
  turns: AskTurn[]
  provider: AssistProviderInfo
  onInsert: (code: string) => void
  onRegenerate: () => void
}): JSX.Element {
  const d = useDict()
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const last = turns[turns.length - 1]

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })

  if (turns.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-4 py-6">
        <p className="font-semibold text-fg text-ui-lg">
          {fmt(d.ask.emptyTitle, { name: provider.name })}
        </p>
        <p className="max-w-[60ch] text-fg-muted text-ui-base">
          {fmt(d.ask.emptyBody, { model: provider.label ?? provider.name })}
        </p>
      </div>
    )
  }

  return (
    <section
      ref={scrollRef}
      aria-label={d.ask.conversation}
      className="ask-conversation min-h-0 flex-1 overflow-y-auto px-3 py-2"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {turns.map((turn) =>
        turn.role === 'user' ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AnswerTurn
            key={turn.id}
            turn={turn}
            onInsert={onInsert}
            onRegenerate={turn === last ? onRegenerate : undefined}
          />
        ),
      )}
    </section>
  )
}

function UserTurn({ turn }: { turn: AskUserTurn }): JSX.Element {
  const d = useDict()
  return (
    <div className="mt-3 first:mt-1" aria-label={d.ask.question}>
      <p className="whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-1.5 text-fg text-ui-base">
        {turn.content}
      </p>
      {turn.context.length > 0 ? (
        <p className="mt-1 px-2.5 text-fg-muted text-ui-xs">
          {fmt(d.ask.sentWith, { items: turn.context.map((c) => c.label).join(', ') })}
        </p>
      ) : null}
    </div>
  )
}

function AnswerTurn({
  turn,
  onInsert,
  onRegenerate,
}: {
  turn: AskAnswerTurn
  onInsert: (code: string) => void
  onRegenerate?: () => void
}): JSX.Element {
  const d = useDict()
  const components = useMemo(() => markdownComponents(onInsert), [onInsert])
  const errorText = turn.error
    ? [d.ask.errors[turn.error.code] ?? d.ask.errors.failed, turn.error.message]
        .filter(Boolean)
        .join(' ')
    : null
  return (
    <div
      className="ask-answer mt-2 px-0.5"
      aria-label={d.ask.answer}
      aria-busy={turn.status === 'streaming'}
    >
      {turn.content ? (
        <article className="typeset typeset-pine">
          <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
            {turn.content}
          </Markdown>
        </article>
      ) : turn.status === 'streaming' ? (
        <p className="text-fg-muted text-ui-base">{d.ask.thinking}</p>
      ) : null}
      {errorText ? (
        <p role="alert" className="mt-1 flex items-center gap-1.5 text-attn-fg text-ui-sm">
          <WarningCircleIcon className="size-3.5 shrink-0" />
          <span>{errorText}</span>
        </p>
      ) : null}
      {turn.status === 'stopped' ? (
        <p className="mt-1 text-fg-muted text-ui-xs">{d.ask.stopped}</p>
      ) : null}
      {onRegenerate && turn.status !== 'streaming' ? (
        <div className="mt-1 flex gap-0.5">
          {turn.content ? <CopyButton text={turn.content} /> : null}
          <IconButton
            icon={ArrowCounterClockwiseIcon}
            label={d.ask.regenerate}
            onClick={onRegenerate}
          />
        </div>
      ) : null}
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm]

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

function codeLanguage(node: HastLike | undefined): string {
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = code?.properties?.className
  const list = Array.isArray(classes) ? classes.map(String) : []
  const match = list.find((c) => c.startsWith('language-'))
  return match ? match.slice('language-'.length) : ''
}

function markdownComponents(onInsert: (code: string) => void): Components {
  return {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    table: ({ node: _node, ...props }) => (
      <div className="typeset-scroll">
        <table {...props} />
      </div>
    ),
    pre: ({ node, children }) => {
      const hast = node as HastLike | undefined
      const code = hast ? hastText(hast).replace(/\n$/, '') : ''
      return (
        <CodeBlock language={codeLanguage(hast)} code={code} onInsert={onInsert}>
          {children}
        </CodeBlock>
      )
    },
  }
}

function CodeBlock({
  language,
  code,
  onInsert,
  children,
}: {
  language: string
  code: string
  onInsert: (code: string) => void
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  return (
    <div className="ask-code not-typeset" data-language={language || undefined}>
      <div className="ask-code-bar">
        <span className="font-mono text-fg-muted text-ui-xs">{language}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <CopyButton text={code} />
          {isShellLanguage(language) ? (
            <Button variant="ghost" size="xs" onClick={() => onInsert(code)}>
              <TerminalWindowIcon />
              {d.ask.insert}
            </Button>
          ) : null}
        </span>
      </div>
      <pre className="ask-code-body">{children}</pre>
    </div>
  )
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const d = useDict()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      icon={copied ? CheckIcon : CopyIcon}
      label={copied ? d.ask.copied : d.ask.copy}
      className={cn(copied && 'text-fg')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }}
    />
  )
}
