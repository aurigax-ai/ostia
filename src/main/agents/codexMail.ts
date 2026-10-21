import { MAIL_REFUSED } from '../../shared/agents/agentIssues'
import { ackMail, failLeased, releaseMail } from './busStore'
import type { CodexRpc } from './codexRpc'
import { mailers } from './mailers'
import { takeMailTurn } from './mailTurn'

export interface CodexMailDeps {
  socketOf: (externalId: string) => string | undefined
  connect: (socketPath: string) => Promise<CodexRpc>
  threadOf: (externalId: string) => Promise<string | undefined>
  agentBusy: (externalId: string) => boolean
  schedule: (ms: number, fn: () => void) => void
  now: () => number
}

const FAILURE_COOLDOWN_MS = 10_000
const RECENT_TURNS = 5
const REFUSALS_MAX = 5

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsOf)
  return []
}

export class CodexMail {
  private readonly attached = new Set<string>()
  private readonly clients = new Map<string, CodexRpc>()
  private readonly delivering = new Set<string>()
  private readonly coolUntil = new Map<string, number>()
  private readonly refusals = new Map<string, number>()

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
    this.refusals.delete(externalId)
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

  private async started(
    externalId: string,
    socket: string,
    threadId: string,
    ids: string[],
  ): Promise<boolean> {
    try {
      this.clients.get(externalId)?.close()
      this.clients.delete(externalId)
      const rpc = await this.client(externalId, socket)
      const recent = await rpc.request('thread/turns/list', {
        threadId,
        limit: RECENT_TURNS,
        itemsView: 'full',
        sortDirection: 'desc',
      })
      const texts = stringsOf(recent)
      return ids.some((id) => texts.some((text) => text.includes(`<message id="${id}"`)))
    } catch {
      return false
    }
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
    let sent = false
    try {
      const rpc = await this.client(externalId, socket)
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: turn.text }] })
      sent = true
    } catch {
      sent = await this.started(externalId, socket, threadId, turn.ids)
    }
    if (sent) {
      this.refusals.delete(externalId)
      ackMail(externalId, turn.lease)
      if (turn.retryMs !== undefined) this.deps.schedule(turn.retryMs, () => this.kick(externalId))
    } else {
      mailers.unrecordTurn(externalId)
      const refused = (this.refusals.get(externalId) ?? 0) + 1
      if (refused >= REFUSALS_MAX) {
        this.refusals.delete(externalId)
        failLeased(externalId, turn.lease, MAIL_REFUSED)
      } else {
        this.refusals.set(externalId, refused)
        releaseMail(externalId, turn.lease)
      }
      this.coolUntil.set(externalId, this.deps.now() + FAILURE_COOLDOWN_MS)
      this.deps.schedule(FAILURE_COOLDOWN_MS, () => this.kick(externalId))
      this.clients.get(externalId)?.close()
      this.clients.delete(externalId)
    }
  }
}
