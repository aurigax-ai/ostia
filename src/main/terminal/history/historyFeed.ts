import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FlowMarks } from '../ptyFlow'
import type { PaneHistory } from './paneHistory'
import type { BlockEnd, SpillEvent, SpillRequest } from './spillHost'

export interface SpillPort {
  postMessage(request: SpillRequest, transfer?: ArrayBuffer[]): void
  on(type: 'message', listener: (event: SpillEvent) => void): unknown
}

export interface SpillPressure {
  readonly canPause: boolean
  hold(chars: number): void
  release(chars: number): void
  close(): void
}

export interface HistoryFeed {
  readonly seqBase: number
  readonly continues: boolean
  write(data: string): void
  restore(history: string): void
  resize(cols: number, rows: number): void
  watchScreen(screen: () => string): void
  tail(): Promise<string[]>
  pendingEnd(seq: number): Promise<BlockEnd | null>
  close(): Promise<void>
}

export const SPILL_BACKLOG: FlowMarks = { high: 12 * 1024 * 1024, low: 9 * 1024 * 1024 }
export const SPILL_PAUSE: FlowMarks = { high: 3 * 1024 * 1024, low: 2 * 1024 * 1024 }
const SPILL_QUIET_MS = 100
export const PANE_SEND_CHARS = 1024 * 1024
export const SLICE_CHARS = 256 * 1024
const SPILL_HEAP_LIMITS = { maxYoungGenerationSizeMb: 4, maxOldGenerationSizeMb: 1024 }
const utf8 = new TextEncoder()

type Reply = Extract<SpillEvent, { kind: 'reply' }>

interface Session {
  history: PaneHistory
  pressure: SpillPressure | null
  unsent: string[]
  unsentChars: number
  inFlight: number
  dropping: boolean
  screen: () => string
  closing: (() => void) | null
}

export class SpillClient {
  private readonly sessions = new Map<number, Session>()
  private readonly replies = new Map<number, (reply: Reply | null) => void>()
  private sending: ReturnType<typeof setTimeout> | null = null
  private nextSession = 0
  private nextReply = 0
  private ended = false

  constructor(private readonly port: SpillPort) {
    port.on('message', (event) => this.receive(event))
  }

  get alive(): boolean {
    return !this.ended
  }

  open(
    history: PaneHistory,
    cols: number,
    rows: number,
    pressure: SpillPressure | null = null,
  ): HistoryFeed {
    const id = this.nextSession++
    const seqBase = history.seqOffset
    const continues = history.end > history.first
    const session: Session = {
      history,
      pressure,
      unsent: [],
      unsentChars: 0,
      inFlight: 0,
      dropping: false,
      screen: () => '',
      closing: null,
    }
    this.sessions.set(id, session)
    this.post({ kind: 'open', session: id, cols, rows, end: history.end, seqOffset: seqBase })
    let closed: Promise<void> | null = null
    return {
      seqBase,
      continues,
      write: (data) => this.queue(session, id, data),
      restore: (text) =>
        this.post({ kind: 'restore', session: id, history: text, hold: continues }),
      resize: (c, r) => this.post({ kind: 'resize', session: id, cols: c, rows: r }),
      watchScreen: (screen) => {
        session.screen = screen
      },
      tail: async () => (await this.ask({ kind: 'tail', session: id }))?.tail ?? [],
      pendingEnd: async (seq) =>
        (await this.ask({ kind: 'pendingEnd', session: id, seq }))?.pendingEnd ?? null,
      close: () => {
        if (closed) return closed
        closed = new Promise((resolve) => {
          session.closing = resolve
        })
        if (this.ended) this.settle(id, session)
        else this.post({ kind: 'close', session: id })
        return closed
      },
    }
  }

  end(reason: string): void {
    if (this.ended) return
    this.ended = true
    if (this.sending) clearTimeout(this.sending)
    this.sending = null
    for (const [id, session] of [...this.sessions]) {
      session.history.fail(reason)
      this.settle(id, session)
    }
    for (const settle of this.replies.values()) settle(null)
    this.replies.clear()
  }

  private queue(session: Session, id: number, data: string): void {
    if (this.ended || !data || session.dropping) return
    if (!session.pressure?.canPause && this.backlog(session) + data.length > SPILL_BACKLOG.high) {
      session.dropping = true
      return
    }
    session.unsent.push(data)
    session.unsentChars += data.length
    session.pressure?.hold(data.length)
    if (session.unsentChars >= PANE_SEND_CHARS) this.sendSession(session, id)
    else if (this.sending) this.sending.refresh()
    else {
      this.sending = setTimeout(() => this.sendAll(), SPILL_QUIET_MS)
      this.sending.unref()
    }
  }

  private backlog(session: Session): number {
    return session.unsentChars + session.inFlight
  }

  private sendAll(): void {
    if (this.sending) clearTimeout(this.sending)
    this.sending = null
    for (const [id, session] of this.sessions) this.sendSession(session, id)
  }

  private sendSession(session: Session, id: number): void {
    const parts = session.unsent
    if (parts.length === 0) return
    session.unsent = []
    session.unsentChars = 0
    let slice: string[] = []
    let chars = 0
    const ship = () => {
      if (chars === 0) return
      const data = utf8.encode(slice.join(''))
      session.inFlight += chars
      this.deliver({ kind: 'write', session: id, data, chars }, [data.buffer])
      slice = []
      chars = 0
    }
    for (const part of parts) {
      if (chars > 0 && chars + part.length > SLICE_CHARS) ship()
      slice.push(part)
      chars += part.length
    }
    ship()
  }

  private parsed(session: Session, id: number, chars: number): void {
    session.inFlight = Math.max(0, session.inFlight - chars)
    session.pressure?.release(chars)
    if (!session.dropping || this.backlog(session) > SPILL_BACKLOG.low) return
    session.dropping = false
    this.post({ kind: 'resync', session: id, screen: session.screen() })
  }

  private settle(id: number, session: Session): void {
    this.sessions.delete(id)
    session.pressure?.close()
    session.unsent = []
    session.closing?.()
  }

  private post(request: SpillRequest): void {
    if (this.sending) this.sendAll()
    this.deliver(request)
  }

  private deliver(request: SpillRequest, transfer?: ArrayBuffer[]): void {
    if (this.ended) return
    try {
      this.port.postMessage(request, transfer)
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
    const session = this.sessions.get(event.session)
    if (!session) return
    const { history } = session
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
      case 'parsed':
        this.parsed(session, event.session, event.chars)
        return
      case 'closed':
        history.seqOffset = event.seqEnd
        this.settle(event.session, session)
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
