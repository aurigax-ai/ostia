import {
  AGENT_CONTEXT_MAX,
  AGENT_PROMPT_MAX,
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
import { BUS_CONTEXT_MAX } from '../../shared/agents/busMessages'
import { type CoreCallRequest, type CoreLifecycle, coreLifecycle } from './agentCoreCall'
import type { PromptMail, TakePromptMail } from './agentMail'
import { type AgentOpenInput, completeOf, promptOf, sessionIdOf } from './agentRequests'
import { PiStream } from './piStream'
import { type PortalPromptResult, PortalPrompts } from './portalPrompts'

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
  coreCall: (request: CoreCallRequest) => Promise<AgentToolReply>
  promptMail: TakePromptMail
  rulesContext: (
    workspaceId: string,
    cwd: string,
    sessionId: string,
  ) => Promise<{ text: string; count: number }>
}

interface Owned {
  renderer: AgentRenderer
  workspaceId: string
  paneId: string
}

interface PendingTool {
  rendererId: number
  sessionId: string
  name: string
  input: Record<string, unknown>
  core: CoreLifecycle | null
  settle: (reply: AgentToolReply) => void
}

interface MailHold {
  lifecycle: CoreLifecycle
  released: boolean
}

const MAIL_SEPARATOR = '\n\n'
const UNAVAILABLE: AgentReply = { ok: false, error: 'unavailable' }
const INVALID_CALL: AgentToolReply = { ok: false, error: 'invalid' }
const CANCELLED: AgentToolReply = { ok: false, error: 'Cancelled.' }
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
  private readonly streams = new Map<string, PiStream>()
  private readonly waiting = new Map<string, Set<string>>()
  private readonly waitListeners = new Map<string, Set<(waiting: boolean) => void>>()
  private readonly portal = new PortalPrompts({
    renderer: (sessionId) => {
      const renderer = this.owned.get(sessionId)?.renderer
      return renderer && !renderer.isDestroyed() ? renderer : null
    },
    stream: (sessionId) => this.streams.get(sessionId),
  })
  private readonly holds = new Map<string, Set<MailHold>>()
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
    const { context, count } = await this.rulesFor(input)
    const reply = await this.deps.request({
      op: 'open',
      sessionId: input.sessionId,
      cwd: input.cwd,
      tools: input.tools,
      providers,
      ...(input.model ? { model: input.model } : {}),
      ...(context ? { context } : {}),
    })
    if (!reply.ok) return reply
    this.owned.set(input.sessionId, {
      renderer,
      workspaceId: input.workspaceId,
      paneId: input.paneId,
    })
    if (!this.streams.has(input.sessionId)) {
      const stream = new PiStream()
      stream.seed(reply.history ?? [])
      this.streams.set(input.sessionId, stream)
    }
    return { ...reply, rules: count }
  }

  private async rulesFor(input: AgentOpenInput): Promise<{ context: string; count: number }> {
    if (!input.rules) return { context: '', count: 0 }
    const found = await this.deps
      .rulesContext(input.workspaceId, input.cwd, input.sessionId)
      .catch(() => ({ text: '', count: 0 }))
    if (!found.text || found.count <= 0) return { context: '', count: 0 }
    const clean = await this.deps.redact(found.text.slice(0, AGENT_CONTEXT_MAX)).catch(() => null)
    return clean ? { context: clean, count: found.count } : { context: '', count: 0 }
  }

  async prompt(renderer: AgentRenderer, sessionId: unknown, text: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    const owner = id ? this.owned.get(id) : undefined
    const clean = promptOf(text)
    if (!id || !owner || clean === null) return { ok: false, error: 'invalid' }
    if (this.sandboxedSession(id)) return { ok: false, error: 'sandboxed' }
    const redacted = await this.deps.redact(clean).catch(() => null)
    if (redacted === null) return { ok: false, error: 'redaction-failed' }
    const hold = this.hold(id)
    try {
      const mail = await this.mailFor(owner, renderer, hold, redacted.length)
      const body = await this.withMail(redacted, mail?.text)
      if (body === null) return { ok: false, error: 'redaction-failed' }
      if (hold.released) return { ok: false, error: 'cancelled' }
      const reply = await this.deps.request({ op: 'prompt', sessionId: id, text: body })
      if (!reply.ok) return reply
      this.streams.get(id)?.prompt(clean)
      await mail?.ack().catch(() => undefined)
      return reply
    } finally {
      this.unhold(id, hold)
    }
  }

  private async mailFor(
    owner: Owned,
    renderer: AgentRenderer,
    hold: MailHold,
    promptLength: number,
  ): Promise<PromptMail | null> {
    if (promptLength + BUS_CONTEXT_MAX + MAIL_SEPARATOR.length > AGENT_PROMPT_MAX) return null
    return this.deps.promptMail(
      { paneId: owner.paneId, windowId: String(renderer.id), workspaceId: owner.workspaceId },
      hold.lifecycle,
    )
  }

  private async withMail(prompt: string, mail: string | undefined): Promise<string | null> {
    if (!mail) return prompt
    const clean = await this.deps.redact(mail).catch(() => null)
    return clean === null ? null : `${clean}${MAIL_SEPARATOR}${prompt}`
  }

  private hold(sessionId: string): MailHold {
    const hold: MailHold = { lifecycle: coreLifecycle(), released: false }
    const holds = this.holds.get(sessionId) ?? new Set<MailHold>()
    holds.add(hold)
    this.holds.set(sessionId, holds)
    return hold
  }

  private unhold(sessionId: string, hold: MailHold): void {
    this.release(hold)
    const holds = this.holds.get(sessionId)
    holds?.delete(hold)
    if (holds?.size === 0) this.holds.delete(sessionId)
  }

  private release(hold: MailHold): void {
    if (hold.released) return
    hold.released = true
    hold.lifecycle.end()
  }

  private releaseHolds(sessionId: string): void {
    for (const hold of this.holds.get(sessionId) ?? []) this.release(hold)
  }

  async complete(params: unknown): Promise<AgentReply> {
    const asked = completeOf(params)
    if (!asked) return { ok: false, error: 'invalid' }
    const { providers } = this.deps.settings()
    if (providers.length === 0) return { ok: false, error: 'no-model' }
    const system = await this.deps.redact(asked.system).catch(() => null)
    const input = await this.deps.redact(asked.input).catch(() => null)
    if (system === null || input === null) return { ok: false, error: 'redaction-failed' }
    return this.deps.request({ op: 'complete', system, input, providers })
  }

  async abort(renderer: AgentRenderer, sessionId: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    if (!id) return { ok: false, error: 'invalid' }
    this.cancelTools(id)
    this.releaseHolds(id)
    return this.deps.request({ op: 'abort', sessionId: id })
  }

  async close(renderer: AgentRenderer, sessionId: unknown): Promise<AgentReply> {
    const id = this.ownedId(renderer, sessionId)
    if (!id) return { ok: false, error: 'invalid' }
    this.cancelTools(id)
    this.releaseHolds(id)
    this.forget(id)
    return this.deps.request({ op: 'close', sessionId: id })
  }

  event(fromAgent: boolean, params: unknown): { ok: boolean } {
    if (!fromAgent || !isRecord(params)) return { ok: false }
    const id = sessionIdOf(params.sessionId)
    const owner = id ? this.owned.get(id) : undefined
    if (!id || !owner || owner.renderer.isDestroyed()) return { ok: false }
    const event = params.event as AgentEvent
    this.streams.get(id)?.event(event)
    owner.renderer.send('agent:event', { sessionId: id, event })
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
        sessionId: call.sessionId,
        name: call.name,
        input: call.input,
        core: null,
        settle: (answer) => {
          subscription?.dispose()
          resolve(answer)
        },
      })
      owner.renderer.send('agent:tool-call', { callId, ...call })
    })
    this.streams
      .get(call.sessionId)
      ?.toolResult(call.toolCallId, reply.ok ? reply.output : reply.error, !reply.ok)
    return this.checked(reply)
  }

  stream(sessionId: string): PiStream | undefined {
    return this.streams.get(sessionId)
  }

  sessionOfPane(paneId: string): string | undefined {
    for (const [sessionId, owner] of this.owned) if (owner.paneId === paneId) return sessionId
    return undefined
  }

  promptFromPortal(sessionId: string, text: string): Promise<PortalPromptResult> {
    return this.portal.prompt(sessionId, text)
  }

  noteWaiting(renderer: AgentRenderer, callId: unknown, on: unknown): void {
    if (typeof callId !== 'string' || typeof on !== 'boolean') return
    const pending = this.pending.get(callId)
    if (!pending || pending.rendererId !== renderer.id) return
    this.setWaiting(pending.sessionId, callId, on)
  }

  watchWaiting(sessionId: string, listener: (waiting: boolean) => void): () => void {
    const listeners = this.waitListeners.get(sessionId) ?? new Set()
    this.waitListeners.set(sessionId, listeners)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  private setWaiting(sessionId: string, callId: string, on: boolean): void {
    const calls = this.waiting.get(sessionId) ?? new Set<string>()
    this.waiting.set(sessionId, calls)
    const before = calls.size > 0
    if (on) calls.add(callId)
    else calls.delete(callId)
    const after = calls.size > 0
    if (before === after) return
    for (const listener of [...(this.waitListeners.get(sessionId) ?? [])]) listener(after)
  }

  private forget(sessionId: string): void {
    this.portal.forget(sessionId)
    this.waiting.delete(sessionId)
    this.waitListeners.delete(sessionId)
    this.owned.delete(sessionId)
    this.streams.delete(sessionId)
  }

  answerTool(renderer: AgentRenderer, callId: unknown, reply: unknown): void {
    if (typeof callId !== 'string') return
    const pending = this.pending.get(callId)
    if (!pending || pending.rendererId !== renderer.id) return
    this.settle(callId, toolReplyOf(reply))
  }

  async coreCall(
    renderer: AgentRenderer,
    sessionId: unknown,
    callId: unknown,
  ): Promise<AgentToolReply> {
    const id = this.ownedId(renderer, sessionId)
    const owner = id ? this.owned.get(id) : undefined
    if (typeof callId !== 'string' || !id || !owner) return INVALID_CALL
    const pending = this.pending.get(callId)
    if (!pending || pending.sessionId !== id) return INVALID_CALL
    if (pending.rendererId !== renderer.id || pending.core) return INVALID_CALL
    const lifecycle = coreLifecycle()
    pending.core = lifecycle
    const reply = await this.deps.coreCall({
      scope: {
        paneId: owner.paneId,
        windowId: String(renderer.id),
        workspaceId: owner.workspaceId,
      },
      name: pending.name,
      input: pending.input,
      lifecycle,
    })
    return this.pending.get(callId) === pending ? reply : CANCELLED
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
    this.setWaiting(pending.sessionId, callId, false)
    pending.core?.end()
    pending.settle(reply)
  }

  private cancelTools(sessionId: string): void {
    const owner = this.owned.get(sessionId)
    if (!owner) return
    for (const [callId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue
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
        this.releaseHolds(sessionId)
        this.forget(sessionId)
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
