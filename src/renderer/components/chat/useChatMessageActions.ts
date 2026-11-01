import type { UseChatHelpers } from '@ai-sdk/react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { messageText, type OstiaChatMessage } from '@/lib/assist/chatTransport'
import { clearSession, saveSession } from '@/stores/assist/chatStore'
import { focusAtEnd } from './useChatFocus'
import type { SlashCard } from './useChatSlash'

function quoteText(text: string): string {
  return `${text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\n`
}

interface ChatMessageActionsParams {
  sessionId: string
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'messages' | 'setMessages' | 'stop' | 'clearError'>
  setStopped: Dispatch<SetStateAction<ReadonlySet<string>>>
  setEditing: (id: string | null) => void
  setDraft: Dispatch<SetStateAction<string>>
  setConfirmClear: (open: boolean) => void
  setCard: (card: SlashCard) => void
  areaRef: RefObject<HTMLTextAreaElement | null>
}

export function useChatMessageActions({
  sessionId,
  chat,
  setStopped,
  setEditing,
  setDraft,
  setConfirmClear,
  setCard,
  areaRef,
}: ChatMessageActionsParams) {
  const { messages, setMessages, stop, clearError } = chat
  const onStop = (): void => {
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') setStopped((prev) => new Set(prev).add(last.id))
    void stop()
  }

  const deleteMessage = (id: string): void => {
    setMessages(messages.filter((m) => m.id !== id))
    void saveSession(sessionId)
  }

  const startEdit = (message: OstiaChatMessage): void => {
    setEditing(message.id)
    setDraft(messageText(message))
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }

  const quote = (text: string): void => {
    setDraft((prev) => `${quoteText(text)}${prev}`)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }

  const clearChat = (): void => {
    setConfirmClear(false)
    setEditing(null)
    setStopped(new Set())
    setCard(null)
    clearError()
    void clearSession(sessionId)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }
  return { onStop, deleteMessage, startEdit, quote, clearChat }
}

export type ChatMessageActions = ReturnType<typeof useChatMessageActions>
