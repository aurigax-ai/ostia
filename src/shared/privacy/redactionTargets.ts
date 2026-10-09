import type {
  AssistPoint,
  AssistRequests,
  ChatAssistRequest,
  ChatMessage,
  CompletionAssistRequest,
  TerminalAssistRequest,
} from '../assist'
import type { ChatPart, ChatSession, ChatSessionMessage } from '../assist/chatSessions'
import type { RedactionResult } from './redaction'

export type RedactText = (text: string) => Promise<string>

interface Counted {
  text: RedactText
  count: () => number
}

function counted(redact: (text: string) => Promise<RedactionResult>): Counted {
  let count = 0
  return {
    text: async (text) => {
      const result = await redact(text)
      count += result.count
      return result.text
    },
    count: () => count,
  }
}

async function completionTexts(
  request: CompletionAssistRequest,
  text: RedactText,
): Promise<CompletionAssistRequest> {
  const out: CompletionAssistRequest = {
    ...request,
    prefix: await text(request.prefix),
    suffix: await text(request.suffix),
  }
  if (request.neighbors) {
    out.neighbors = []
    for (const n of request.neighbors) out.neighbors.push({ ...n, text: await text(n.text) })
  }
  return out
}

async function terminalTexts(
  request: TerminalAssistRequest,
  text: RedactText,
): Promise<TerminalAssistRequest> {
  const out: TerminalAssistRequest = { ...request, line: await text(request.line) }
  if (request.history) {
    out.history = []
    for (const h of request.history) out.history.push({ ...h, command: await text(h.command) })
  }
  if (request.context) {
    out.context = []
    for (const c of request.context) out.context.push({ ...c, text: await text(c.text) })
  }
  return out
}

async function chatMessageTexts(message: ChatMessage, text: RedactText): Promise<ChatMessage> {
  const out: ChatMessage = { ...message, content: await text(message.content) }
  if (message.tools) {
    out.tools = []
    for (const tool of message.tools) {
      out.tools.push({
        ...tool,
        ...(tool.output === undefined ? {} : { output: await text(tool.output) }),
        ...(tool.error === undefined ? {} : { error: await text(tool.error) }),
      })
    }
  }
  return out
}

async function chatTexts(request: ChatAssistRequest, text: RedactText): Promise<ChatAssistRequest> {
  const messages: ChatMessage[] = []
  for (const message of request.messages) messages.push(await chatMessageTexts(message, text))
  const context: ChatAssistRequest['context'] = []
  for (const item of request.context) context.push({ ...item, text: await text(item.text) })
  return { ...request, messages, context }
}

export async function redactAssistRequest<P extends AssistPoint>(
  point: P,
  request: AssistRequests[P],
  redact: (text: string) => Promise<RedactionResult>,
): Promise<{ request: AssistRequests[P]; count: number }> {
  const { text, count } = counted(redact)
  const all = request as AssistRequests[AssistPoint]
  let out: AssistRequests[AssistPoint]
  if (point === 'input') {
    const input = all as AssistRequests['input']
    out = { ...input, text: await text(input.text) }
  } else if (point === 'command') {
    const command = all as AssistRequests['command']
    out = { ...command, query: await text(command.query) }
  } else if (point === 'completion') {
    out = await completionTexts(all as CompletionAssistRequest, text)
  } else if (point === 'terminal') {
    out = await terminalTexts(all as TerminalAssistRequest, text)
  } else {
    out = await chatTexts(all as ChatAssistRequest, text)
  }
  return { request: out as AssistRequests[P], count: count() }
}

async function deepTexts(value: unknown, text: RedactText, depth = 0): Promise<unknown> {
  if (typeof value === 'string') return text(value)
  if (depth > 8 || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await deepTexts(item, text, depth + 1))
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = await deepTexts(item, text, depth + 1)
  return out
}

async function partTexts(part: ChatPart, role: string, text: RedactText): Promise<ChatPart> {
  if (part.type === 'text' && typeof part.text === 'string') {
    return role === 'user' ? { ...part, text: await text(part.text) } : part
  }
  const out: ChatPart = { ...part }
  if (part.output !== undefined) out.output = await deepTexts(part.output, text)
  if (typeof part.errorText === 'string') out.errorText = await text(part.errorText)
  return out
}

async function messageTexts(
  message: ChatSessionMessage,
  text: RedactText,
): Promise<ChatSessionMessage> {
  const parts: ChatPart[] = []
  for (const part of message.parts) parts.push(await partTexts(part, message.role, text))
  const out: ChatSessionMessage = { ...message, parts }
  const context = message.metadata?.context
  if (context) {
    const items: typeof context = []
    for (const item of context) items.push({ ...item, text: await text(item.text) })
    out.metadata = { ...message.metadata, context: items }
  }
  return out
}

export async function redactChatSession(
  session: ChatSession,
  text: RedactText,
): Promise<ChatSession> {
  const messages: ChatSessionMessage[] = []
  for (const message of session.messages) messages.push(await messageTexts(message, text))
  return { ...session, title: await text(session.title), messages }
}
