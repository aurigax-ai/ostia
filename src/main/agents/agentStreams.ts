import type { AgentResume } from '../../shared/agents/agentResume'
import type { StreamAgent, StreamEnd, StreamEvent } from '../../shared/agents/agentStream'
import type { PiStream } from '../agent/piStream'
import type { Ask, AskResolved } from '../approvals/asks'
import type { PaneIdentity } from '../control/idRegistry'
import { isErrno, reportError } from '../diagnostics/errorReport'
import type { PaneEntry } from '../panes/paneList'
import type { CodexNotice, CodexRpc } from './codexRpc'
import { claudeSource } from './streamClaude'
import { codexSource } from './streamCodex'
import { piSource } from './streamPi'
import type { StreamSource } from './streamSource'

export interface AgentStreamsDeps {
  panes: () => Promise<PaneEntry[]>
  claudeFile: (sessionId: string, pane: PaneIdentity) => Promise<string | null>
  codexSocket: (externalPaneId: string) => string | undefined
  codexConnect: (socket: string, onNotice: CodexNotice) => Promise<CodexRpc>
  pi: (sessionId: string) => PiStream | undefined
  asks: () => Ask[]
}

export type StreamSend = (events: StreamEvent[], backfill: boolean) => void

export type StreamOpenError = 'not-an-agent' | 'unavailable'

export interface PreparedStream {
  agent: StreamAgent
  session: string | null
  truncated: boolean
  start: (send: StreamSend) => void
  close: () => void
}

interface Target {
  agent: StreamAgent
  session: string | null
}

function targetOf(entry: PaneEntry | undefined): Target | null {
  if (!entry) return null
  if (entry.kind === 'agent') {
    return entry.agentSessionId ? { agent: 'pi', session: entry.agentSessionId } : null
  }
  if (entry.agent === 'claude' || entry.agent === 'codex') {
    return { agent: entry.agent, session: entry.agentSessionId ?? null }
  }
  return null
}

class StreamUnavailable extends Error {}

function reportUnexpected(err: unknown): void {
  if (!(err instanceof StreamUnavailable) && !isErrno(err)) reportError('agentStreams', err)
}

class Subscription {
  source: StreamSource | null = null
  session: string | null
  truncated = false
  private send: StreamSend | null = null
  private held: Array<{ events: StreamEvent[]; backfill: boolean }> = []
  private chain: Promise<void> = Promise.resolve()
  private closed = false
  readonly asks = new Set<string>()

  constructor(
    readonly pane: PaneIdentity,
    readonly agent: StreamAgent,
    session: string | null,
    readonly turns: number,
    private readonly make: (session: string, sub: Subscription) => StreamSource,
    private readonly openAsks: () => Ask[],
    private readonly release: (sub: Subscription) => void,
  ) {
    this.session = session
  }

  async prepare(): Promise<void> {
    if (this.session === null) return
    this.source = this.make(this.session, this)
    const backfill = await this.source.backfill(this.turns)
    this.truncated = backfill.truncated
    this.held.push({
      events: [...backfill.events, ...this.askEvents(), { type: 'live' }],
      backfill: true,
    })
  }

  start(send: StreamSend): void {
    if (this.closed) return
    this.send = send
    if (this.session === null)
      this.held.push({ events: [...this.askEvents(), { type: 'live' }], backfill: true })
    for (const batch of this.held) send(batch.events, batch.backfill)
    this.held = []
    this.goLive()
  }

  private goLive(): void {
    this.source?.live((events) => this.deliver(events, false))
  }

  deliver(events: StreamEvent[], backfill: boolean): void {
    if (this.closed || events.length === 0) return
    if (this.send) this.send(events, backfill)
    else this.held.push({ events, backfill })
  }

  switchTo(session: string): void {
    this.chain = this.chain.then(async () => {
      if (this.closed || session === this.session) return
      this.source?.close()
      this.source = null
      this.session = session
      this.deliver([{ type: 'session', session }], false)
      try {
        this.source = this.make(session, this)
        const backfill = await this.source.backfill(this.turns)
        this.deliver([...backfill.events, { type: 'live' }], true)
        this.goLive()
      } catch (err) {
        reportUnexpected(err)
        this.end('agent-closed')
      }
    })
  }

  askOpened(ask: Ask): void {
    this.asks.add(ask.askId)
    this.deliver([{ type: 'ask', askId: ask.askId, kind: ask.kind }], false)
  }

  askResolved(resolved: AskResolved): void {
    if (this.asks.delete(resolved.askId)) {
      this.deliver(
        [{ type: 'ask.resolved', askId: resolved.askId, outcome: resolved.outcome }],
        false,
      )
    }
  }

  end(reason: StreamEnd): void {
    if (this.closed) return
    this.deliver([{ type: 'ended', reason }], false)
    this.close()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.source?.close()
    this.source = null
    this.send = null
    this.held = []
    this.release(this)
  }

  private askEvents(): StreamEvent[] {
    const open = this.openAsks().filter((ask) => ask.paneId === this.pane.externalId)
    for (const ask of open) this.asks.add(ask.askId)
    return open.map((ask) => ({ type: 'ask', askId: ask.askId, kind: ask.kind }))
  }
}

export class AgentStreams {
  private readonly subs = new Set<Subscription>()

  constructor(private readonly deps: AgentStreamsDeps) {}

  async open(
    pane: PaneIdentity,
    turns: number,
  ): Promise<PreparedStream | { error: StreamOpenError }> {
    const target = targetOf((await this.deps.panes()).find((p) => p.paneId === pane.externalId))
    if (!target) return { error: 'not-an-agent' }
    const sub = new Subscription(
      pane,
      target.agent,
      target.session,
      turns,
      (session, owner) => this.source(owner, session),
      this.deps.asks,
      (done) => this.subs.delete(done),
    )
    this.subs.add(sub)
    try {
      await sub.prepare()
    } catch (err) {
      reportUnexpected(err)
      sub.close()
      return { error: 'unavailable' }
    }
    return {
      agent: sub.agent,
      session: sub.session,
      truncated: sub.truncated,
      start: (send) => sub.start(send),
      close: () => sub.close(),
    }
  }

  resumed(externalPaneId: string, resume: AgentResume): void {
    for (const sub of this.subs) {
      if (sub.pane.externalId === externalPaneId && sub.agent === resume.agent) {
        sub.switchTo(resume.id)
      }
    }
  }

  async agentsChanged(): Promise<void> {
    const watched = [...this.subs].filter((sub) => sub.agent !== 'pi')
    if (watched.length === 0) return
    const panes = await this.deps.panes()
    for (const sub of watched) {
      const entry = panes.find((p) => p.paneId === sub.pane.externalId)
      if (entry?.agent !== sub.agent) sub.end('agent-closed')
    }
  }

  paneClosed(paneId: string): void {
    for (const sub of [...this.subs]) if (sub.pane.paneId === paneId) sub.end('pane-closed')
  }

  askOpened(ask: Ask): void {
    for (const sub of this.subs) if (sub.pane.externalId === ask.paneId) sub.askOpened(ask)
  }

  askResolved(resolved: AskResolved): void {
    for (const sub of [...this.subs]) sub.askResolved(resolved)
  }

  private source(sub: Subscription, session: string): StreamSource {
    if (sub.agent === 'claude') {
      return claudeSource({
        find: () => this.deps.claudeFile(session, sub.pane),
        session,
        closed: (reason) => sub.end(reason),
      })
    }
    if (sub.agent === 'pi') {
      const stream = this.deps.pi(session)
      if (!stream) throw new StreamUnavailable()
      return piSource(stream)
    }
    const socket = this.deps.codexSocket(sub.pane.externalId)
    if (!socket) throw new StreamUnavailable()
    return codexSource({
      threadId: session,
      connect: (onNotice) => this.deps.codexConnect(socket, onNotice),
      closed: (reason) => sub.end(reason),
    })
  }
}
