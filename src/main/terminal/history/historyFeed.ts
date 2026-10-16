import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { PaneHistory } from './paneHistory'
import type { BlockEnd, SpillEvent, SpillRequest } from './spillHost'

export interface SpillPort {
  postMessage(request: SpillRequest): void
  on(type: 'message', listener: (event: SpillEvent) => void): unknown
}

export interface HistoryFeed {
  readonly seqBase: number
  readonly continues: boolean
  write(data: string): void
  restore(history: string): void
  resize(cols: number, rows: number): void
  tail(): Promise<string[]>
  pendingEnd(seq: number): Promise<BlockEnd | null>
  close(commandStarts: number): Promise<void>
}

const SPILL_HEAP_LIMITS = { maxYoungGenerationSizeMb: 4, maxOldGenerationSizeMb: 1024 }

type Reply = Extract<SpillEvent, { kind: 'reply' }>

export class SpillClient {
  private readonly sessions = new Map<number, PaneHistory>()
  private readonly closing = new Map<number, () => void>()
  private readonly replies = new Map<number, (reply: Reply | null) => void>()
  private readonly historyIds = new WeakMap<PaneHistory, number>()
  private readonly unsent = new Map<number, string[]>()
  private sending: ReturnType<typeof setImmediate> | null = null
  private nextHistory = 0
  private nextSession = 0
  private nextReply = 0
  private ended = false

  constructor(private readonly port: SpillPort) {
    port.on('message', (event) => this.receive(event))
  }

  get alive(): boolean {
    return !this.ended
  }

  open(history: PaneHistory, cols: number, rows: number): HistoryFeed {
    const session = this.nextSession++
    const seqBase = history.seqOffset
    this.sessions.set(session, history)
    this.post({
      kind: 'open',
      session,
      history: this.historyId(history),
      cols,
      rows,
      end: history.end,
      seqOffset: seqBase,
    })
    const continues = history.end > history.first
    let closed: Promise<void> | null = null
    return {
      seqBase,
      continues,
      write: (data) => this.queue(session, data),
      restore: (text) => this.post({ kind: 'restore', session, history: text, hold: continues }),
      resize: (c, r) => this.post({ kind: 'resize', session, cols: c, rows: r }),
      tail: async () => (await this.ask({ kind: 'tail', session }))?.tail ?? [],
      pendingEnd: async (seq) =>
        (await this.ask({ kind: 'pendingEnd', session, seq }))?.pendingEnd ?? null,
      close: (commandStarts) => {
        if (closed) return closed
        history.seqOffset = seqBase + commandStarts
        closed = this.ended
          ? Promise.resolve()
          : new Promise((resolve) => this.closing.set(session, resolve))
        this.post({ kind: 'close', session })
        return closed
      },
    }
  }

  end(reason: string): void {
    if (this.ended) return
    this.ended = true
    if (this.sending) clearImmediate(this.sending)
    this.sending = null
    this.unsent.clear()
    for (const history of this.sessions.values()) history.fail(reason)
    this.sessions.clear()
    for (const settle of this.replies.values()) settle(null)
    this.replies.clear()
    for (const resolve of this.closing.values()) resolve()
    this.closing.clear()
  }

  private historyId(history: PaneHistory): number {
    let id = this.historyIds.get(history)
    if (id === undefined) {
      id = this.nextHistory++
      this.historyIds.set(history, id)
    }
    return id
  }

  private queue(session: number, data: string): void {
    if (this.ended || !data) return
    const pending = this.unsent.get(session)
    if (pending) pending.push(data)
    else this.unsent.set(session, [data])
    this.sending ??= setImmediate(() => this.send())
  }

  private send(): void {
    if (this.sending) clearImmediate(this.sending)
    this.sending = null
    const batches = [...this.unsent]
    this.unsent.clear()
    for (const [session, parts] of batches)
      this.deliver({ kind: 'write', session, data: parts.join('') })
  }

  private post(request: SpillRequest): void {
    if (this.unsent.size > 0) this.send()
    this.deliver(request)
  }

  private deliver(request: SpillRequest): void {
    if (this.ended) return
    try {
      this.port.postMessage(request)
    } catch (err) {
      this.end(err instanceof Error ? err.message : 'spill-post-failed')
    }
  }

  private ask(
    request:
      | Omit<Extract<SpillRequest, { kind: 'tail' }>, 'id'>
      | Omit<Extract<SpillRequest, { kind: 'pendingEnd' }>, 'id'>,
  ): Promise<Reply | null> {
    if (this.ended) return Promise.resolve(null)
    const id = this.nextReply++
    return new Promise((resolve) => {
      this.replies.set(id, resolve)
      this.post({ ...request, id } as SpillRequest)
    })
  }

  private receive(event: SpillEvent): void {
    if (event.kind === 'reply') {
      const settle = this.replies.get(event.id)
      this.replies.delete(event.id)
      settle?.(event)
      return
    }
    const history = this.sessions.get(event.session)
    if (!history) return
    switch (event.kind) {
      case 'append':
        history.append(event.text, event.count)
        return
      case 'blockStarted':
        history.blockStarted(event.seq, event.start, event.command)
        return
      case 'blockEnded':
        history.blockEnded(event.seq, event.end, event.endCol, event.exitCode, event.command)
        return
      case 'wipe':
        history.wipe()
        return
      case 'flush':
        void history.flush()
        return
      case 'closed':
        this.sessions.delete(event.session)
        this.closing.get(event.session)?.()
        this.closing.delete(event.session)
    }
  }
}

export function historyWorkerScript(appPath: string): string {
  return join(appPath.replace(/\.asar$/, '.asar.unpacked'), 'out/history/worker.js')
}

export function spillWorker(script: string): Worker {
  const worker = new Worker(script, { resourceLimits: SPILL_HEAP_LIMITS })
  worker.unref()
  return worker
}

export function startSpillWorker(script: string): SpillClient {
  const worker = spillWorker(script)
  const client = new SpillClient(worker as unknown as SpillPort)
  worker.on('error', (err) => client.end(err.message))
  worker.on('exit', () => client.end('spill-worker-exited'))
  return client
}
