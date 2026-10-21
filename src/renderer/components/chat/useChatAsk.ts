import type { UseChatHelpers } from '@ai-sdk/react'
import type { ChatContextItem } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { useEffect, useMemo, useState } from 'react'
import {
  ASK_CONTEXT_ORDER,
  type AskContextKind,
  askContextOptions,
  liveSelectionContext,
} from '@/lib/assist/askContext'
import { redactedCount, redactOutgoing } from '@/lib/assist/chatRedaction'
import { parseSlash } from '@/lib/assist/chatSlash'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { nameSession, useChatStore } from '@/stores/assist/chatStore'
import type { ChatContext } from './useChatContext'
import type { SlashCard } from './useChatSlash'

export const REDACTION_PREVIEW_MS = 300

function sentContext(
  enabled: ReadonlySet<AskContextKind>,
  fresh: Partial<Record<AskContextKind, ChatContextItem>>,
): ChatContextItem[] {
  const sameFile =
    enabled.has('selection') && fresh.selection?.path === fresh.editor?.path && fresh.editor
  return ASK_CONTEXT_ORDER.filter((kind) => enabled.has(kind) && !(kind === 'editor' && sameFile))
    .map((kind) => fresh[kind])
    .filter((item): item is ChatContextItem => item !== undefined)
}

interface ChatAskParams {
  workspaceId: string | null
  sessionId: string
  chatKey: string
  labels: Record<AskContextKind, string>
  context: ChatContext
  attachments: ChatContextItem[]
  draft: string
  setDraft: (draft: string) => void
  busy: boolean
  editing: string | null
  setEditing: (id: string | null) => void
  chat: Pick<
    UseChatHelpers<OstiaChatMessage>,
    'messages' | 'setMessages' | 'sendMessage' | 'clearError'
  >
  setNotice: (notice: null) => void
  setCard: (card: SlashCard) => void
}

export function useChatAsk({
  workspaceId,
  sessionId,
  chatKey: key,
  labels,
  context,
  attachments,
  draft,
  setDraft,
  busy,
  editing,
  setEditing,
  chat,
  setNotice,
  setCard,
}: ChatAskParams) {
  const { options, setOptions, enabled, selectedText } = context
  const { messages, setMessages, sendMessage, clearError } = chat
  const ask = (text: string, extra: ChatContextItem[] = []): void => {
    const question = text.trim()
    if (!question || busy) return
    setCard(null)
    const selection = liveSelectionContext(workspaceId, labels.selection)
    const fresh = {
      ...askContextOptions(labels, workspaceId),
      ...(selection ? { selection } : {}),
    }
    setOptions(fresh)
    const context = [...extra, ...attachments, ...sentContext(enabled, fresh)]
    if (editing) {
      const at = messages.findIndex((m) => m.id === editing)
      if (at >= 0) setMessages(messages.slice(0, at))
      setEditing(null)
    }
    setDraft('')
    setNotice(null)
    clearError()
    useChatStore.getState().clearAttachments(key)
    void redactOutgoing(question, context).then((safe) => {
      nameSession(sessionId, safe.question)
      void sendMessage({
        text: safe.question,
        metadata:
          safe.context.length > 0
            ? { createdAt: Date.now(), context: safe.context }
            : { createdAt: Date.now() },
      })
    })
  }

  const [willRedact, setWillRedact] = useState(0)
  const outgoingTexts = useMemo(() => {
    const selected = selectedText
      ? { selection: { kind: 'selection' as const, label: '', text: selectedText } }
      : {}
    return [
      parseSlash(draft) === null ? draft : '',
      ...attachments.map((item) => item.text),
      ...sentContext(enabled, { ...options, ...selected }).map((item) => item.text),
    ]
  }, [draft, attachments, enabled, options, selectedText])
  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      void redactedCount(outgoingTexts).then((count) => {
        if (!stale) setWillRedact(count)
      })
    }, REDACTION_PREVIEW_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [outgoingTexts])
  return { ask, willRedact }
}
