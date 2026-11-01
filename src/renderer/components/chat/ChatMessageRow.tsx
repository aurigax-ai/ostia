import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
  QuotesIcon,
  TextTIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { type JSX, useMemo, useRef } from 'react'
import type { Components } from 'react-markdown'
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message'
import { useCopied } from '@/lib/app/useCopied'
import { fmt, useDict } from '@/lib/app/useDict'
import { rehypeFileLinks } from '@/lib/assist/chatLinks'
import { redactedCountLabel, redactionsIn } from '@/lib/assist/chatRedaction'
import {
  isToolPart,
  messageText,
  type OstiaChatMessage,
  type ToolPartLike,
} from '@/lib/assist/chatTransport'
import { ChatToolPart } from './ChatToolPart'

const REHYPE_PLUGINS = [rehypeFileLinks]

type Segment =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tool'; key: string; part: ToolPartLike }

function messageSegments(message: Pick<OstiaChatMessage, 'parts'>): Segment[] {
  const out: Segment[] = []
  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      const last = out[out.length - 1]
      if (last?.kind === 'text') last.text += part.text
      else out.push({ kind: 'text', key: `t${index}`, text: part.text })
    } else if (isToolPart(part)) {
      out.push({ kind: 'tool', key: part.toolCallId, part })
    }
  })
  return out.filter((s) => s.kind === 'tool' || s.text.trim() !== '')
}

export function ChatMessageRow({
  message,
  workspaceId,
  components,
  streaming,
  stopped,
  editing,
  busy,
  onCopied,
  onQuote,
  onEdit,
  onDelete,
  onRestore,
  onRegenerate,
}: {
  message: OstiaChatMessage
  workspaceId: string | null
  components: Components
  streaming: boolean
  stopped: boolean
  editing: boolean
  busy: boolean
  onCopied: () => void
  onQuote: (text: string) => void
  onEdit?: (message: OstiaChatMessage) => void
  onDelete?: (id: string) => void
  onRestore?: () => void
  onRegenerate?: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatActions
  const text = messageText(message)
  const segments = useMemo(() => messageSegments(message), [message])
  const contentRef = useRef<HTMLDivElement>(null)
  const copyPlain = (): void => {
    const plain = contentRef.current?.innerText ?? text
    void navigator.clipboard?.writeText(plain.trim()).then(onCopied, () => undefined)
  }
  const common = (
    <>
      <CopyMessageAction text={text} label={t.copyMarkdown} />
      <MessageAction label={t.copyText} onClick={copyPlain} icon={TextTIcon} />
      <MessageAction label={t.quote} onClick={() => onQuote(text)} icon={QuotesIcon} />
    </>
  )
  if (message.role === 'user') {
    const context = message.metadata?.context ?? []
    const redacted = redactionsIn(text, context)
    const sentNotes = [
      context.length > 0
        ? fmt(d.ask.sentWith, { items: context.map((c) => c.label).join(', ') })
        : null,
      redacted > 0 ? redactedCountLabel(d, redacted) : null,
    ].filter((note): note is string => note !== null)
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
        {sentNotes.length > 0 ? (
          <p className="px-2.5 text-fg-muted text-ui-xs">{sentNotes.join(' · ')}</p>
        ) : null}
        <MessageActions className="chat-message-actions">
          {common}
          {onEdit ? (
            <MessageAction
              label={t.edit}
              disabled={busy}
              onClick={() => onEdit(message)}
              icon={PencilSimpleIcon}
            />
          ) : null}
          {onRestore ? (
            <MessageAction
              label={d.chatTools.checkpoint.action}
              disabled={busy}
              onClick={onRestore}
              icon={ArrowCounterClockwiseIcon}
            />
          ) : null}
          {onDelete ? (
            <MessageAction
              label={t.deleteMessage}
              disabled={busy}
              onClick={() => onDelete(message.id)}
              icon={TrashIcon}
            />
          ) : null}
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
        {segments.length > 0 ? (
          <div ref={contentRef} className="flex flex-col gap-2">
            {segments.map((segment) =>
              segment.kind === 'text' ? (
                <MessageResponse
                  key={segment.key}
                  components={components}
                  rehypePlugins={REHYPE_PLUGINS}
                >
                  {segment.text}
                </MessageResponse>
              ) : (
                <ChatToolPart
                  key={segment.key}
                  part={segment.part}
                  workspaceId={workspaceId}
                  busy={streaming}
                />
              ),
            )}
          </div>
        ) : null}
      </MessageContent>
      {stopped ? <p className="text-fg-muted text-ui-xs">{d.ask.stopped}</p> : null}
      {!streaming && text ? (
        <MessageActions className="chat-message-actions">
          {common}
          {onRegenerate ? (
            <MessageAction
              label={d.ask.regenerate}
              onClick={onRegenerate}
              icon={ArrowClockwiseIcon}
            />
          ) : null}
          {onDelete ? (
            <MessageAction
              label={t.deleteMessage}
              disabled={busy}
              onClick={() => onDelete(message.id)}
              icon={TrashIcon}
            />
          ) : null}
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
      label={copied ? d.ask.copied : label}
      icon={copied ? CheckIcon : CopyIcon}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(setCopied, () => undefined)
      }}
    />
  )
}
