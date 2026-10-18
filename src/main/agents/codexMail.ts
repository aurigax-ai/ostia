import { ackMail, releaseMail } from './busStore'
import type { CodexRpc } from './codexRpc'
import { takeMailTurn } from './mailTurn'
import { mailers } from './mailers'

export interface CodexMailDeps {
  socketOf: (externalId: string) => string | undefined
  connect: (socketPath: string) => Promise<CodexRpc>
  threadOf: (externalId: string) => Promise<string | undefined>
  agentBusy: (externalId: string) => boolean
  schedule: (ms: number, fn: () => void) => void
  now: () => number
}

const FAILURE_COOLDOWN_MS = 10_000

export class CodexMail {
  private readonly attached = new Set<string>()
  private readonly clients = new Map<string, CodexRpc>()
  private readonly delivering = new Set<string>()
  private readonly coolUntil = new Map<string, number>()

  constructor(private readonly deps: CodexMailDeps) {}

  attachedIds(): string[] {
    return [...this.attached]
  }

  attach(externalId: string): void {
    this.attached.add(externalId)
    mailers.set(externalId, false)
    this.kick(externalId)
  }

  detach(externalId: string): void {
    this.attached.delete(externalId)
    this.coolUntil.delete(externalId)
    this.clients.get(externalId)?.close()
    this.clients.delete(externalId)
    mailers.clear(externalId)
  }

  kick(externalId: string): void {
    if (!this.attached.has(externalId) || this.delivering.has(externalId)) return
    if (this.deps.now() < (this.coolUntil.get(externalId) ?? 0)) return
    this.delivering.add(externalId)
    void this.deliver(externalId).finally(() => this.delivering.delete(externalId))
  }

  private async client(externalId: string, socket: string): Promise<CodexRpc> {
    const known = this.clients.get(externalId)
    if (known) return known
    const fresh = await this.deps.connect(socket)
    this.clients.set(externalId, fresh)
    void fresh.closed.then(() => {
      if (this.clients.get(externalId) === fresh) this.clients.delete(externalId)
    })
    return fresh
  }

  private async deliver(externalId: string): Promise<void> {
    const socket = this.deps.socketOf(externalId)
    const threadId = socket ? await this.deps.threadOf(externalId) : undefined
    if (!socket || !threadId || !this.attached.has(externalId)) return
    const turn = takeMailTurn(externalId, this.deps.agentBusy(externalId))
    if (!('text' in turn)) {
      if ('retryMs' in turn) this.deps.schedule(turn.retryMs, () => this.kick(externalId))
      return
    }
    try {
      const rpc = await this.client(externalId, socket)
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: turn.text }] })
      ackMail(externalId, turn.lease)
      if (turn.retryMs !== undefined) this.deps.schedule(turn.retryMs, () => this.kick(externalId))
    } catch {
      releaseMail(externalId, turn.lease)
      this.coolUntil.set(externalId, this.deps.now() + FAILURE_COOLDOWN_MS)
      this.deps.schedule(FAILURE_COOLDOWN_MS, () => this.kick(externalId))
      this.clients.get(externalId)?.close()
      this.clients.delete(externalId)
    }
  }
}
