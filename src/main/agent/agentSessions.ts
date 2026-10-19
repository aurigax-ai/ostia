import {
  AGENT_TOOL_CALL_ID_MAX,
  AGENT_TOOL_OUTPUT_MAX,
  type AgentEvent,
  type AgentReply,
  type AgentRequest,
  type AgentToolCall,
  type AgentToolReply,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { AgentHostSettings } from '../../shared/agent/agentSettings'
import { type AgentOpenInput, promptOf, sessionIdOf } from './agentRequests'

export interface AgentRenderer {
  id: number
  send: (channel: string, payload: unknown) => void
  isDestroyed: () => boolean
  once: (event: 'destroyed', listener: () => void) => void
}

export interface AgentSessionsDeps {
  request: (request: AgentRequest) => Promise<AgentReply>
  settings: () => AgentHostSettings
  sandboxed: (workspaceId: string) => boolean
  redact: (text: string) => Promise<string | null>
}

interface Owned {
  renderer: AgentRenderer
  workspaceId: string
}

interface PendingTool {
  rendererId: number
  settle: (reply: AgentToolReply) => void
}

const UNAVAILABLE: AgentReply = { ok: false, error: 'unavailable' }
const DENIED_GONE: AgentToolReply = { ok: false, error: 'The window that owns this chat closed.' }
const SANDBOXED: AgentToolReply = {
  ok: false,
  error: 'The Agent is not available in a sandboxed workspace.',
}
const UNREDACTED: AgentToolReply = {
  ok: false,
  error: 'The result could not be checked for secrets, so it was not sent.',
}

export class AgentSessions {
  private readonly owned = new Map<string, Owned>()
  private readonly pending = new Map<string, PendingTool>()
  private readonly watched = new Set<number>()
  private toolSeq = 0

  constructor(private readonly deps: AgentSessionsDeps) {}

  async open(renderer: AgentRenderer, input: AgentOpenInput): Promise<AgentReply> {
    this.watch(renderer)
    if (this.deps.sandboxed(input.workspaceId)) return { ok: false, error: 'sandboxed' }
    const { providers } = this.deps.settings()
    const wanted = input.model
    if (
      wanted &&
      !providers.some((p) => p.id === wanted.provider && p.models.includes(wanted.model))
    ) {
      return { ok: false, error: 'unknown-model' }
    }
    const reply = await this.deps.request({
      op: 'open',
      sessionId: input.sessionId,
      cwd: input.cwd,
      tools: input.tools,
      providers,
      ...(input.model ? { model: input.model } : {}),
    })
    if (reply.ok) this.owned.set(input.sessionId, { renderer, workspaceId: input.workspaceId })
    return reply
  }

  async prompt(renderer: AgentRenderer, sessionId: unknown, text: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    const clean = promptOf(text)
    if (!id || clean === null) return { ok: false, error: 'invalid' }
    if (this.sandboxedSession(id)) return { ok: false, error: 'sandboxed' }
    const redacted = await this.deps.redact(clean).catch(() => null)
    if (redacted === null) return { ok: false, error: 'redaction-failed' }
    return this.deps.request({ op: 'prompt', sessionId: id, text: redacted })
  }

  async abort(renderer: AgentRenderer, sessionId: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    if (!id) return { ok: false, error: 'invalid' }
    this.cancelTools(id)
    return this.deps.request({ op: 'abort', sessionId: id })
  }

  async close(renderer: AgentRenderer, sessionId: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    if (!id) return { ok: false, error: 'invalid' }
    this.owned.delete(id)
    this.cancelTools(id)
    return this.deps.request({ op: 'close', sessionId: id })
  }

  event(fromAgent: boolean, params: unknown): { ok: boolean } {
    if (!fromAgent || !isRecord(params)) return { ok: false }
    const id = sessionIdOf(params.sessionId)
    const owner = id ? this.owned.get(id) : undefined
    if (!id || !owner || owner.renderer.isDestroyed()) return { ok: false }
    owner.renderer.send('agent:event', { sessionId: id, event: params.event as AgentEvent })
    return { ok: true }
  }

  async tool(
    fromAgent: boolean,
    params: unknown,
    cancelled: (listener: () => void) => { dispose: () => void } | undefined,
  ): Promise<AgentToolReply> {
    const call = toolCallOf(fromAgent, params)
    if (!call) return { ok: false, error: 'invalid' }
    const owner = this.owned.get(call.sessionId)
    if (!owner || owner.renderer.isDestroyed()) return DENIED_GONE
    if (this.deps.sandboxed(owner.workspaceId)) return SANDBOXED
    const callId = `t${++this.toolSeq}`
    const reply = await new Promise<AgentToolReply>((resolve) => {
      const subscription = cancelled(() => {
        owner.renderer.send('agent:tool-cancel', { callId })
        this.settle(callId, { ok: false, error: 'Cancelled.' })
      })
      this.pending.set(callId, {
        rendererId: owner.renderer.id,
        settle: (answer) => {
          subscription?.dispose()
          resolve(answer)
        },
      })
      owner.renderer.send('agent:tool-call', { callId, ...call })
    })
    return this.checked(reply)
  }

  answerTool(renderer: AgentRenderer, callId: unknown, reply: unknown): void {
    if (typeof callId !== 'string') return
    const pending = this.pending.get(callId)
    if (!pending || pending.rendererId !== renderer.id) return
    this.settle(callId, toolReplyOf(reply))
  }

  private async checked(reply: AgentToolReply): Promise<AgentToolReply> {
    const text = reply.ok ? reply.output : reply.error
    const clean = await this.deps.redact(text.slice(0, AGENT_TOOL_OUTPUT_MAX)).catch(() => null)
    if (clean === null) return UNREDACTED
    if (reply.ok) return { ok: true, output: clean }
    return reply.denied ? { ok: false, error: clean, denied: true } : { ok: false, error: clean }
  }

  private settle(callId: string, reply: AgentToolReply): void {
    const pending = this.pending.get(callId)
    if (!pending) return
    this.pending.delete(callId)
    pending.settle(reply)
  }

  private cancelTools(sessionId: string): void {
    const owner = this.owned.get(sessionId)
    if (!owner) return
    for (const [callId, pending] of this.pending) {
      if (pending.rendererId !== owner.renderer.id) continue
      owner.renderer.send('agent:tool-cancel', { callId })
      this.settle(callId, { ok: false, error: 'Cancelled.' })
    }
  }

  private sandboxedSession(sessionId: string): boolean {
    const owner = this.owned.get(sessionId)
    return owner !== undefined && this.deps.sandboxed(owner.workspaceId)
  }

  private ownedId(renderer: AgentRenderer, sessionId: unknown): string | null {
    const id = sessionIdOf(sessionId)
    return id && this.owned.get(id)?.renderer.id === renderer.id ? id : null
  }

  private watch(renderer: AgentRenderer): void {
    if (this.watched.has(renderer.id)) return
    this.watched.add(renderer.id)
    renderer.once('destroyed', () => {
      this.watched.delete(renderer.id)
      for (const [callId, pending] of this.pending) {
        if (pending.rendererId === renderer.id) this.settle(callId, DENIED_GONE)
      }
      for (const [sessionId, owner] of this.owned) {
        if (owner.renderer.id !== renderer.id) continue
        this.owned.delete(sessionId)
        void this.deps.request({ op: 'close', sessionId })
      }
    })
  }
}

function toolCallOf(fromAgent: boolean, params: unknown): AgentToolCall | null {
  if (!fromAgent || !isRecord(params)) return null
  const sessionId = sessionIdOf(params.sessionId)
  const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId : ''
  if (!sessionId || !toolCallId || toolCallId.length > AGENT_TOOL_CALL_ID_MAX) return null
  if (typeof params.name !== 'string' || !isRecord(params.input)) return null
  return { sessionId, toolCallId, name: params.name, input: params.input }
}

function toolReplyOf(raw: unknown): AgentToolReply {
  if (!isRecord(raw)) return { ok: false, error: 'invalid' }
  if (raw.ok === true && typeof raw.output === 'string') return { ok: true, output: raw.output }
  const error = typeof raw.error === 'string' ? raw.error.slice(0, 2000) : 'failed'
  return raw.denied === true ? { ok: false, error, denied: true } : { ok: false, error }
}

export const NO_AGENT = UNAVAILABLE
