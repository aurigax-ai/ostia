import { assistRequest, chatModel } from '@/stores/assistStore'
import {
  ASSIST_ERRORS,
  type AssistError,
  type AssistModelRef,
  CHAT_CONTEXT_MAX,
  CHAT_TOOL_CALLS_MAX,
  CHAT_TOOL_ERROR_MAX,
  CHAT_TOOL_OUTPUT_MAX,
  type ChatAssistRequest,
  type ChatContextItem,
  type ChatMessage,
  type ChatToolCall,
} from '@shared/assist'
import type { ChatMessageMetadata } from '@shared/chatSessions'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { redactToolOutput } from './chatRedaction'
import { type ChatToolDef, type ToolOutcome, type ToolRun, chatToolDefs } from './chatTools'

export type OstiaChatMessage = UIMessage<ChatMessageMetadata>

type Part = OstiaChatMessage['parts'][number]

export interface ToolPartLike {
  type: string
  toolCallId: string
  toolName?: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  approval?: { approved?: boolean }
}

const TEXT_ID = 'answer'
export const MAX_TOOL_ROUNDS = 8
export const OLD_TOOL_OUTPUT_MAX = 2000
export const STOPPED_TOOL_ERROR = 'Not run: the chat was stopped.'

export function messageText(message: Pick<OstiaChatMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

export function isToolPart(part: { type: string }): part is ToolPartLike & Part {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

export function toolNameOf(part: ToolPartLike): string {
  return part.type === 'dynamic-tool' ? (part.toolName ?? '') : part.type.slice('tool-'.length)
}

export function outputText(output: unknown, max = CHAT_TOOL_OUTPUT_MAX): string {
  const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? '')
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

function inputObject(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

export function toolCallOf(part: ToolPartLike, outputMax = CHAT_TOOL_OUTPUT_MAX): ChatToolCall {
  const base = { id: part.toolCallId, name: toolNameOf(part), input: inputObject(part.input) }
  if (part.state === 'output-available') {
    return { ...base, state: 'done', output: outputText(part.output, outputMax) }
  }
  if (
    part.state === 'output-denied' ||
    (part.state === 'approval-responded' && part.approval?.approved === false)
  ) {
    return { ...base, state: 'denied' }
  }
  if (part.state === 'output-error') {
    return {
      ...base,
      state: 'error',
      error: (part.errorText ?? 'failed').slice(0, CHAT_TOOL_ERROR_MAX),
    }
  }
  return { ...base, state: 'error', error: STOPPED_TOOL_ERROR }
}

function assistantTurns(message: OstiaChatMessage, outputMax: number): ChatMessage[] {
  const turns: ChatMessage[] = []
  let text = ''
  let tools: ChatToolCall[] = []
  const flush = (): void => {
    if (tools.length > 0) turns.push({ role: 'assistant', content: text, tools })
    else if (text.trim()) turns.push({ role: 'assistant', content: text })
    text = ''
    tools = []
  }
  for (const part of message.parts) {
    if (part.type === 'step-start') flush()
    else if (part.type === 'text') text += part.text
    else if (isToolPart(part) && tools.length < CHAT_TOOL_CALLS_MAX) {
      tools.push(toolCallOf(part, outputMax))
    }
  }
  flush()
  return turns
}

export function toChatRequest(messages: readonly OstiaChatMessage[]): ChatAssistRequest {
  const turns: ChatMessage[] = []
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({ role: 'user', content: messageText(message) })
      return
    }
    if (message.role !== 'assistant' || message.metadata?.error) return
    const outputMax = index < lastUser ? OLD_TOOL_OUTPUT_MAX : CHAT_TOOL_OUTPUT_MAX
    turns.push(...assistantTurns(message, outputMax))
  })
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

export interface TransportSession {
  sessionId: string
  workspaceId: () => string | null
  root: () => string
  model: () => AssistModelRef | null
}

interface PendingCall {
  id: string
  name: string
  input: Record<string, unknown>
  error?: string
}

function outcomeCall(call: PendingCall, outcome: ToolOutcome): ChatToolCall {
  const base = { id: call.id, name: call.name, input: call.input }
  if (outcome.state === 'done')
    return { ...base, state: 'done', output: outputText(outcome.output) }
  if (outcome.state === 'denied') return { ...base, state: 'denied' }
  return { ...base, state: 'error', error: outcome.error.slice(0, CHAT_TOOL_ERROR_MAX) }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

export function createAssistTransport(session?: TransportSession): ChatTransport<OstiaChatMessage> {
  return {
    sendMessages: async ({ messages, abortSignal }) => {
      const base = toChatRequest(messages)
      const target = chatModel(session?.model())
      const model = target?.label
      const defs: ChatToolDef[] = session && target?.tools ? chatToolDefs(session.sessionId) : []
      const signal = abortSignal ?? new AbortController().signal
      return new ReadableStream<UIMessageChunk>({
        start: async (controller) => {
          let started = false
          let textOpen = false
          let closed = false
          const metadata: ChatMessageMetadata = model
            ? { createdAt: Date.now(), model }
            : { createdAt: Date.now() }
          const emit = (chunk: UIMessageChunk): void => {
            if (closed) return
            try {
              controller.enqueue(chunk)
            } catch {
              closed = true
            }
          }
          const close = (): void => {
            if (closed) return
            closed = true
            try {
              controller.close()
            } catch {}
          }
          const begin = (): void => {
            if (started) return
            started = true
            emit({ type: 'start', messageMetadata: metadata })
          }
          const openText = (): void => {
            begin()
            if (textOpen) return
            textOpen = true
            emit({ type: 'text-start', id: TEXT_ID })
          }
          const steps: ChatMessage[] = []
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const request: ChatAssistRequest = {
              ...base,
              messages: [...base.messages, ...steps],
              ...(defs.length > 0 ? { tools: defs.map((d) => d.spec) } : {}),
            }
            let structured = false
            let roundText = ''
            const calls: PendingCall[] = []
            const res = await assistRequest('chat', request, {
              signal,
              ...(target ? { model: target.ref } : {}),
              onChunk: (text) => {
                const chunk = parseChunk(text)
                if (!chunk) {
                  openText()
                  roundText += text
                  emit({ type: 'text-delta', id: TEXT_ID, delta: text })
                  return
                }
                structured = true
                if (chunk.type === 'start') {
                  if (started) return
                  started = true
                  emit({
                    ...chunk,
                    messageMetadata: { ...metadata, ...(chunk.messageMetadata ?? {}) },
                  })
                  return
                }
                if (chunk.type === 'finish') return
                begin()
                if (chunk.type === 'text-delta') roundText += chunk.delta
                if (chunk.type === 'tool-input-available' && calls.length < CHAT_TOOL_CALLS_MAX) {
                  calls.push({
                    id: chunk.toolCallId,
                    name: chunk.toolName,
                    input: inputObject(chunk.input),
                  })
                }
                if (chunk.type === 'tool-input-error' && calls.length < CHAT_TOOL_CALLS_MAX) {
                  calls.push({
                    id: chunk.toolCallId,
                    name: chunk.toolName,
                    input: inputObject(chunk.input),
                    error: chunk.errorText,
                  })
                }
                emit(chunk)
              },
            })
            if (!res.ok) {
              if (res.error !== 'cancelled') {
                begin()
                emit({ type: 'error', errorText: encodeChatError(res.error, res.message) })
              }
              close()
              return
            }
            if (!structured) {
              if (!textOpen && res.result.text) {
                openText()
                emit({ type: 'text-delta', id: TEXT_ID, delta: res.result.text })
              }
              begin()
              if (textOpen) emit({ type: 'text-end', id: TEXT_ID })
            }
            if (calls.length === 0 || defs.length === 0 || !session) break
            const resolved: ChatToolCall[] = []
            for (const call of calls) {
              if (signal.aborted) {
                close()
                return
              }
              const outcome = await runCall(call, defs, session, signal, emit)
              if (outcome === null) {
                close()
                return
              }
              resolved.push(outcomeCall(call, outcome))
            }
            steps.push({ role: 'assistant', content: roundText, tools: resolved })
          }
          begin()
          emit({ type: 'finish' })
          close()
        },
      })
    },
    reconnectToStream: async () => null,
  }
}

async function redactedOutcome(outcome: ToolOutcome): Promise<ToolOutcome> {
  if (outcome.state === 'done') {
    return { state: 'done', output: await redactToolOutput(outcome.output) }
  }
  if (outcome.state === 'error') {
    return { state: 'error', error: (await redactToolOutput(outcome.error)) as string }
  }
  return outcome
}

async function runCall(
  call: PendingCall,
  defs: ChatToolDef[],
  session: TransportSession,
  signal: AbortSignal,
  emit: (chunk: UIMessageChunk) => void,
): Promise<ToolOutcome | null> {
  if (call.error !== undefined) return { state: 'error', error: call.error }
  const def = defs.find((d) => d.spec.name === call.name)
  let outcome: ToolOutcome
  if (!def) outcome = { state: 'error', error: `Unknown tool ${call.name}.` }
  else {
    const run: ToolRun = {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId(),
      root: session.root(),
      toolCallId: call.id,
      signal,
      onApproval: (approvalId) =>
        emit({ type: 'tool-approval-request', approvalId, toolCallId: call.id }),
      onAnswer: (approvalId, approved) =>
        emit({ type: 'tool-approval-response', approvalId, approved }),
    }
    try {
      outcome = await def.run(call.input, run)
    } catch (err) {
      if (isAbort(err) || signal.aborted) return null
      outcome = { state: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (signal.aborted) return null
  outcome = await redactedOutcome(outcome)
  if (signal.aborted) return null
  if (outcome.state === 'done') {
    emit({ type: 'tool-output-available', toolCallId: call.id, output: outcome.output as never })
  } else if (outcome.state === 'denied') {
    emit({ type: 'tool-output-denied', toolCallId: call.id })
  } else {
    emit({ type: 'tool-output-error', toolCallId: call.id, errorText: outcome.error })
  }
  return outcome
}
