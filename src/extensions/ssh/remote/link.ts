import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  RemoteMailRequest,
  RemoteMailResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteMail'
import {
  frameLine,
  LINK_DEAD_MS,
  LINK_FRAME_MAX,
  LINK_HEARTBEAT_MS,
  type LinkFrame,
  parseFrame,
} from '../../../shared/remote/linkFrames'
import { parseDesktopRef, parseRemoteRef, remoteRef } from '../../../shared/remote/remoteRef'
import { BUFFER_MAX_BYTES, ByteQueue, type SpawnSsh } from '../channel'
import { type ConnectPlan, planRemote } from '../plan'
import type { NodeBundle } from './bundle'

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const POLL_MS = 1000
const DRAIN_WAIT_MS = 10_000
const WAKE_GAP_MS = 15_000
const LINK_OPTIONS = ['-T', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15']

export interface LinkTimes {
  heartbeatMs: number
  deadMs: number
  pollMs: number
  backoffMinMs: number
  backoffMaxMs: number
  wakeGapMs: number
}

const DEFAULT_LINK_TIMES: LinkTimes = {
  heartbeatMs: LINK_HEARTBEAT_MS,
  deadMs: LINK_DEAD_MS,
  pollMs: POLL_MS,
  backoffMinMs: BACKOFF_MIN_MS,
  backoffMaxMs: BACKOFF_MAX_MS,
  wakeGapMs: WAKE_GAP_MS,
}

export interface HostLinkDeps {
  host: string
  plan: ConnectPlan
  bundle: NodeBundle
  spawn: SpawnSsh
  remoteMail: (request: RemoteMailRequest) => Promise<RemoteMailResult>
  onState: (online: boolean, lastContact: number | null) => void
  times?: LinkTimes
  now?: () => number
  random?: () => number
}

export class HostLink {
  private child: ChildProcessWithoutNullStreams | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private ticker: ReturnType<typeof setInterval> | undefined
  private backoff: number
  private stopped = true
  private lastTick = 0
  private lastContact: number | null = null
  private readonly times: LinkTimes

  constructor(private readonly deps: HostLinkDeps) {
    this.times = deps.times ?? DEFAULT_LINK_TIMES
    this.backoff = this.times.backoffMinMs
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.lastTick = this.now()
    this.ticker = setInterval(() => this.watchWake(), this.times.wakeGapMs / 3)
    this.ticker.unref?.()
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.ticker) clearInterval(this.ticker)
    this.child?.kill('SIGTERM')
  }

  private watchWake(): void {
    const now = this.now()
    const slept = now - this.lastTick > this.times.wakeGapMs
    this.lastTick = now
    if (slept) this.kick()
  }

  kick(): void {
    this.backoff = this.times.backoffMinMs
    if (this.child) this.child.kill('SIGTERM')
    else if (this.timer) {
      clearTimeout(this.timer)
      this.connect()
    }
  }

  private schedule(): void {
    if (this.stopped) return
    const jitter = 1 + (this.deps.random ?? Math.random)() * 0.5
    this.timer = setTimeout(() => this.connect(), Math.round(this.backoff * jitter))
    this.timer.unref?.()
    this.backoff = Math.min(this.backoff * 2, this.times.backoffMaxMs)
  }

  private connect(): void {
    if (this.stopped || this.child) return
    const child = this.deps.spawn([
      'ssh',
      ...planRemote(this.deps.plan, this.deps.bundle.run('link'), LINK_OPTIONS),
    ])
    this.child = child
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {})
    void this.session(child).finally(() => {
      if (this.child === child) this.child = null
      child.kill('SIGTERM')
      this.schedule()
    })
  }

  private write(child: ChildProcessWithoutNullStreams, frame: LinkFrame): void {
    if (!child.stdin.destroyed) child.stdin.write(frameLine(frame))
  }

  private async session(child: ChildProcessWithoutNullStreams): Promise<void> {
    const out = new ByteQueue(BUFFER_MAX_BYTES, () => child.kill('SIGTERM'))
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.on('close', () => out.end())
    child.on('error', () => out.end())
    const inflight = new Set<string>()
    let online = false
    let delivered = 0
    let lastRx = this.now()
    const beat = setInterval(() => {
      if (this.now() - lastRx >= this.times.deadMs) child.kill('SIGTERM')
      else if (online) this.write(child, { t: 'hb' })
    }, this.times.heartbeatMs)
    let poller: ReturnType<typeof setInterval> | undefined
    const push = async (): Promise<number> => {
      const queued = await this.deps.remoteMail({ op: 'out', host: this.deps.host })
      let sent = 0
      for (const mail of queued.ok ? (queued.out ?? []) : []) {
        const target = parseRemoteRef(mail.to)
        if (inflight.has(mail.id) || target?.host !== this.deps.host) continue
        inflight.add(mail.id)
        sent += 1
        this.write(child, {
          t: 'mail',
          id: mail.id,
          from: mail.from,
          to: target.pane,
          text: mail.text,
        })
      }
      return sent
    }
    const settle = async (): Promise<void> => {
      const until = this.now() + DRAIN_WAIT_MS
      while (inflight.size > 0 && this.now() < until && !child.killed) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      online = true
      this.lastContact = this.now()
      this.deps.onState(true, this.lastContact)
      await this.deps.remoteMail({ op: 'link', host: this.deps.host, online: true, delivered })
      this.backoff = this.times.backoffMinMs
      poller = setInterval(() => void push(), this.times.pollMs)
      poller.unref?.()
    }
    this.write(child, { t: 'hello', version: this.deps.bundle.version })
    try {
      for (;;) {
        const line = await out.line(LINK_FRAME_MAX)
        if (line === null) break
        const frame = parseFrame(line)
        if (!frame) continue
        lastRx = this.now()
        this.lastContact = lastRx
        if (frame.t === 'hello-ok') {
          await push()
          void settle()
        } else if (frame.t === 'incompatible') break
        else if (frame.t === 'stored') {
          inflight.delete(frame.id)
          delivered += 1
          await this.deps.remoteMail({ op: 'stored', host: this.deps.host, id: frame.id })
        } else if (frame.t === 'refused') {
          inflight.delete(frame.id)
          await this.deps.remoteMail({
            op: 'refused',
            host: this.deps.host,
            id: frame.id,
            reason: frame.reason,
          })
        } else if (frame.t === 'mail') await this.incoming(child, frame)
      }
    } catch {
      child.kill('SIGTERM')
    } finally {
      clearInterval(beat)
      if (poller) clearInterval(poller)
      this.deps.onState(false, this.lastContact)
      if (online) {
        await this.deps.remoteMail({ op: 'link', host: this.deps.host, online: false })
      }
    }
  }

  private async incoming(
    child: ChildProcessWithoutNullStreams,
    frame: Extract<LinkFrame, { t: 'mail' }>,
  ): Promise<void> {
    const to = parseDesktopRef(frame.to)
    const refused = (reason: string): void =>
      this.write(child, { t: 'refused', id: frame.id, reason })
    if (!to || !parseRemoteRef(remoteRef(this.deps.host, frame.from))) return refused('bad-from')
    const result = await this.deps.remoteMail({
      op: 'in',
      host: this.deps.host,
      mail: { pane: frame.from, id: frame.id, to, text: frame.text },
    })
    if (result.ok) this.write(child, { t: 'stored', id: frame.id })
    else refused(result.error)
  }
}
