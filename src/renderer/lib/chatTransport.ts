import {
  ASSIST_ERRORS,
  type AssistError,
  CHAT_CONTEXT_MAX,
  type ChatAssistRequest,
  type ChatContextItem,
  type ChatMessage,
} from '@shared/assist'
import type { ChatMessageMetadata } from '@shared/chatSessions'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { assistProvider, assistRequest } from '../stores/assistStore'

export type PineChatMessage = UIMessage<ChatMessageMetadata>

const TEXT_ID = 'answer'

export function messageText(message: Pick<PineChatMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

export function toChatRequest(messages: readonly PineChatMessage[]): ChatAssistRequest {
  const turns: ChatMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = messageText(message)
    if (message.role === 'assistant' && (!content.trim() || message.metadata?.error)) continue
    turns.push({ role: message.role, content })
  }
  const context: ChatContextItem[] = []
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue
    for (const item of message.metadata?.context ?? []) {
      if (context.length >= CHAT_CONTEXT_MAX) return { messages: turns, context }
      if (!context.some((c) => c.kind === item.kind && c.label === item.label)) context.push(item)
    }
  }
  return { messages: turns, context }
}

export function parseChunk(text: string): UIMessageChunk | null {
  if (!text.startsWith('{')) return null
  try {
    const value = JSON.parse(text) as { type?: unknown }
    return typeof value?.type === 'string' ? (value as UIMessageChunk) : null
  } catch {
    return null
  }
}

export function encodeChatError(code: AssistError, message?: string): string {
  return message ? `${code}\n${message}` : code
}

export function decodeChatError(text: string): { code: AssistError; message?: string } {
  const [head, ...rest] = text.split('\n')
  const code = ASSIST_ERRORS.includes(head as AssistError) ? (head as AssistError) : 'failed'
  const message = code === head ? rest.join('\n') : text
  return message ? { code, message } : { code }
}

export function createAssistTransport(): ChatTransport<PineChatMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      const request = toChatRequest(messages)
      const model = assistProvider('chat')?.label
      return new ReadableStream<UIMessageChunk>({
        start: async (controller) => {
          let started = false
          let textOpen = false
          let structured = false
          const metadata: ChatMessageMetadata = model
            ? { createdAt: Date.now(), model }
            : { createdAt: Date.now() }
          const begin = (): void => {
            if (started) return
            started = true
            controller.enqueue({ type: 'start', messageMetadata: metadata })
          }
          const openText = (): void => {
            begin()
            if (textOpen) return
            textOpen = true
            controller.enqueue({ type: 'text-start', id: TEXT_ID })
          }
          const res = await assistRequest('chat', request, {
            signal: abortSignal,
            onChunk: (text) => {
              const chunk = parseChunk(text)
              if (!chunk) {
                openText()
                controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta: text })
                return
              }
              structured = true
              if (chunk.type === 'start') {
                started = true
                controller.enqueue({
                  ...chunk,
                  messageMetadata: { ...metadata, ...(chunk.messageMetadata ?? {}) },
                })
                return
              }
              begin()
              controller.enqueue(chunk)
            },
          })
          if (!res.ok) {
            if (res.error !== 'cancelled') {
              begin()
              controller.enqueue({
                type: 'error',
                errorText: encodeChatError(res.error, res.message),
              })
            }
            controller.close()
            return
          }
          if (!structured) {
            if (!textOpen && res.result.text) {
              openText()
              controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta: res.result.text })
            }
            begin()
            if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_ID })
            controller.enqueue({ type: 'finish' })
          }
          controller.close()
        },
      })
    },
    reconnectToStream: async () => null,
  }
}
