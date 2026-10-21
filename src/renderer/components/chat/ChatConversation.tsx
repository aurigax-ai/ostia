import type { UseChatHelpers } from '@ai-sdk/react'
import type {
  AssistProviderInfo,
  ChatContextItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { WarningCircleIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { Components } from 'react-markdown'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import { fmt, useDict } from '@/lib/app/useDict'
import type { AskContextOptions } from '@/lib/assist/askContext'
import type { decodeChatError, OstiaChatMessage } from '@/lib/assist/chatTransport'
import type { ChatVariant } from './ChatHeader'
import { ChatMessageRow } from './ChatMessageRow'
import { ChatSlashHelp } from './ChatSlashMenu'
import type { ChatMessageActions } from './useChatMessageActions'
import type { SlashCard } from './useChatSlash'

interface ChatConversationProps {
  variant: ChatVariant
  workspaceId: string | null
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'messages' | 'clearError'> &
    Partial<Pick<UseChatHelpers<OstiaChatMessage>, 'regenerate'>>
  actions: Pick<ChatMessageActions, 'quote'> &
    Partial<Pick<ChatMessageActions, 'startEdit' | 'deleteMessage'>>
  last: OstiaChatMessage | undefined
  provider: AssistProviderInfo | null
  empty?: { title: string; description: string }
  options: AskContextOptions
  markdown: Components
  busy: boolean
  stopped: ReadonlySet<string>
  editing: string | null
  checkpoints: ReadonlySet<string>
  card: SlashCard
  waiting: boolean
  errorInfo: ReturnType<typeof decodeChatError> | null
  ask: (text: string, extra?: ChatContextItem[]) => void
  setNotice: (notice: 'copiedMessage') => void
  setCheckpoint: (id: string) => void
  setCard: (card: SlashCard) => void
}

export function ChatConversation({
  variant,
  workspaceId,
  chat,
  actions,
  last,
  provider,
  empty,
  options,
  markdown,
  busy,
  stopped,
  editing,
  checkpoints,
  card,
  waiting,
  errorInfo,
  ask,
  setNotice,
  setCheckpoint,
  setCard,
}: ChatConversationProps): JSX.Element {
  const d = useDict()
  const { messages, clearError, regenerate } = chat
  const { quote, startEdit, deleteMessage } = actions
  return (
    <Conversation className={variant === 'palette' ? 'max-h-[48vh]' : undefined}>
      <ConversationContent>
        {messages.length === 0 ? (
          <ConversationEmptyState
            title={
              empty?.title ?? fmt(d.ask.emptyTitle, { name: provider?.name ?? d.chat.paneTitle })
            }
            description={
              empty?.description ??
              (provider
                ? fmt(d.ask.emptyBody, { model: provider.label ?? provider.name })
                : d.chat.noProvider)
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
              components={markdown}
              streaming={busy && message === last}
              stopped={stopped.has(message.id)}
              editing={editing === message.id}
              busy={busy}
              onCopied={() => setNotice('copiedMessage')}
              onQuote={quote}
              onEdit={startEdit}
              onDelete={deleteMessage}
              onRestore={checkpoints.has(message.id) ? () => setCheckpoint(message.id) : undefined}
              onRegenerate={
                regenerate && message === last && message.role === 'assistant' && !busy
                  ? () => {
                      clearError()
                      void regenerate()
                    }
                  : undefined
              }
            />
          ))
        )}
        {card === 'help' ? <ChatSlashHelp onClose={() => setCard(null)} /> : null}
        {waiting ? <ChatWaiting model={provider?.label ?? provider?.name ?? null} /> : null}
        {errorInfo ? (
          <p role="alert" className="flex items-start gap-1.5 text-attn-fg text-ui-sm">
            <WarningCircleIcon className="mt-0.5 size-4 shrink-0" />
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
  )
}

function ChatWaiting({ model }: { model: string | null }): JSX.Element {
  const d = useDict()
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <output className="block px-0.5 text-fg-muted text-ui-base" aria-live="polite">
      {model ? fmt(d.ask.waitingFor, { model, seconds: String(seconds) }) : d.ask.thinking}
    </output>
  )
}
