import {
  AGENT_COMPLETE_OUTPUT_MAX,
  AGENT_PROMPT_MAX,
  AGENT_SESSION_ID_PATTERN,
  AGENT_TOOLS_MAX,
  type AgentEvent,
  type AgentHistoryEntry,
  type AgentReply,
  type AgentRequest,
  type AgentToolCall,
  type AgentToolReply,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { applyPiEnvironment } from './piEnvironment'
import { completeOnce, openPiSession, type PiSession } from './piSession'

export interface AgentHostDeps {
  dataDir: string
  callTool: (call: AgentToolCall, signal: AbortSignal) => Promise<AgentToolReply>
  emit: (sessionId: string, event: AgentEvent) => void
}

interface Live {
  pi: PiSession
  unsubscribe: () => void
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function historyOf(session: AgentSession): AgentHistoryEntry[] {
  const entries: AgentHistoryEntry[] = []
  for (const message of session.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message.content)
    if (text) entries.push({ role: message.role, text })
  }
  return entries
}

function failed(error: string, message?: string): AgentReply {
  return message ? { ok: false, error, message } : { ok: false, error }
}

export function createAgentHost(deps: AgentHostDeps) {
  applyPiEnvironment()
  const live = new Map<string, Live>()

  const forward = (sessionId: string, session: AgentSession): (() => void) =>
    session.subscribe((event) => {
      if (event.type === 'message_update') {
        const inner = event.assistantMessageEvent
        if (inner.type === 'text_delta')
          deps.emit(sessionId, { type: 'text-delta', text: inner.delta })
      } else if (event.type === 'tool_execution_start') {
        deps.emit(sessionId, {
          type: 'tool-call',
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: (event.args ?? {}) as Record<string, unknown>,
        })
      } else if (event.type === 'tool_execution_end') {
        deps.emit(sessionId, {
          type: 'tool-done',
          toolCallId: event.toolCallId,
          isError: event.isError === true,
        })
      } else if (event.type === 'message_end') {
        const message = event.message
        if (message.role === 'assistant' && message.stopReason === 'error') {
          deps.emit(sessionId, { type: 'error', message: message.errorMessage ?? 'failed' })
        }
      } else if (event.type === 'agent_settled') {
        deps.emit(sessionId, { type: 'turn-end' })
      }
    })

  const close = (sessionId: string): void => {
    const entry = live.get(sessionId)
    if (!entry) return
    live.delete(sessionId)
    entry.unsubscribe()
    entry.pi.session.dispose()
  }

  const open = async (req: Extract<AgentRequest, { op: 'open' }>): Promise<AgentReply> => {
    if (!AGENT_SESSION_ID_PATTERN.test(req.sessionId)) return failed('invalid')
    if (req.tools.length > AGENT_TOOLS_MAX) return failed('invalid')
    close(req.sessionId)
    const pi = await openPiSession({
      sessionId: req.sessionId,
      cwd: req.cwd,
      dataDir: deps.dataDir,
      tools: req.tools,
      providers: req.providers,
      ...(req.model ? { model: req.model } : {}),
      ...(req.context ? { context: req.context } : {}),
      callTool: deps.callTool,
    })
    if (!pi.model) {
      pi.session.dispose()
      return failed('no-model')
    }
    live.set(req.sessionId, { pi, unsubscribe: forward(req.sessionId, pi.session) })
    return { ok: true, model: pi.model, history: historyOf(pi.session) }
  }

  const prompt = async (req: Extract<AgentRequest, { op: 'prompt' }>): Promise<AgentReply> => {
    const entry = live.get(req.sessionId)
    if (!entry) return failed('unknown-session')
    if (req.text.length === 0 || req.text.length > AGENT_PROMPT_MAX) return failed('invalid')
    void entry.pi.session
      .prompt(req.text, { expandPromptTemplates: false })
      .catch((err: unknown) => {
        deps.emit(req.sessionId, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
        deps.emit(req.sessionId, { type: 'turn-end' })
      })
    return { ok: true }
  }

  const complete = async (req: Extract<AgentRequest, { op: 'complete' }>): Promise<AgentReply> => {
    const done = await completeOnce(req).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : String(err),
    }))
    if ('error' in done) {
      return done.error === 'no-model' ? failed('no-model') : failed('failed', done.error)
    }
    if (done.text.length > AGENT_COMPLETE_OUTPUT_MAX) return failed('too-long')
    return { ok: true, model: done.model, text: done.text }
  }

  const handle = async (req: AgentRequest): Promise<AgentReply> => {
    if (req.op === 'open') return open(req)
    if (req.op === 'complete') return complete(req)
    if (req.op === 'prompt') return prompt(req)
    if (req.op === 'abort') {
      await live.get(req.sessionId)?.pi.session.abort()
      return { ok: true }
    }
    close(req.sessionId)
    return { ok: true }
  }

  return { handle, closeAll: () => [...live.keys()].forEach(close) }
}
