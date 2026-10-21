import type { Socket } from 'node:net'
import type {
  PhoneScreenEvent,
  PhoneScreenFrame,
  PhoneScreenLink,
  PhoneScreens,
  PhoneScreensController,
} from '@aurigax-ai/ostia-extension-sdk'
import { workspaceLabel } from './screenRegistry'
import {
  type CreatedScreen,
  isOutdated,
  PHONE_SERVICE_VERSION,
  type ScreensResult,
} from './screensCli'
import type { ScreensService } from './screensService'

const OFFER_BUDGET_MS = 4_000
const VERSION_FRESH_MS = 5 * 60_000
const WATCH_FPS = 2
const WATCH_MAX_SIDE = 900
const WATCH_IDLE_MS = 10_000
const ASKED_MS = 60_000
const LABEL_MAX = 80
const LINE_MAX = 16 * 1024 * 1024
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu

export interface PhoneView {
  device: string
  level: 'view' | 'control'
  endsAt: number
  state: 'running' | 'paused'
  foreground: string
  watching: boolean
}

export interface PhoneFrame {
  seq: number
  jpeg: string
}

interface Link {
  info: PhoneScreenLink
  screenId: string
  lease: Socket
  state: 'running' | 'paused'
  foreground: string
  watching: boolean
  polled: number
  frame: PhoneFrame | null
}

type PhoneLease = (
  req: { backend: 'phone'; width: number; height: number; label: string },
  timeoutMs: number,
) => Promise<ScreensResult<{ screen: CreatedScreen; lease: Socket }>>

export interface PhoneLinksDeps {
  phone: Pick<PhoneScreens, 'request' | 'ask'>
  service: Pick<ScreensService, 'adopt'>
  version: () => Promise<string | null>
  prepare: () => Promise<unknown>
  lease: PhoneLease
  changed: (workspaceId: string) => void
  now: () => number
}

function plain(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(HIDDEN, ' ').trim().slice(0, max) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLines(socket: Socket, handle: (message: Record<string, unknown>) => void): void {
  let pending = ''
  socket.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let end = pending.indexOf('\n')
    while (end >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      try {
        const message: unknown = JSON.parse(line)
        if (isRecord(message)) handle(message)
      } catch {}
      end = pending.indexOf('\n')
    }
    if (pending.length > LINE_MAX) socket.destroy()
  })
}

function write(socket: Socket, message: unknown): void {
  if (socket.writable) socket.write(`${JSON.stringify(message)}\n`)
}

export class PhoneLinks {
  private readonly links = new Map<string, Link>()
  private readonly asked = new Map<string, number>()
  private known: { version: string | null; at: number } | null = null

  constructor(private readonly deps: PhoneLinksDeps) {}

  async warm(): Promise<void> {
    const version = await this.deps.version()
    if (version) await this.deps.prepare()
    this.known = { version, at: this.deps.now() }
  }

  private async version(): Promise<string | null> {
    const known = this.known
    if (known?.version && this.deps.now() - known.at < VERSION_FRESH_MS) return known.version
    await this.warm()
    return this.known?.version ?? null
  }

  controller(): PhoneScreensController {
    return {
      offer: (link) => this.offer(link),
      frame: (frame) => this.frame(frame),
      event: (event) => this.event(event),
    }
  }

  async offer(info: PhoneScreenLink): Promise<boolean> {
    const deadline = this.deps.now() + OFFER_BUDGET_MS
    const version = await this.version()
    if (!version || isOutdated(version, PHONE_SERVICE_VERSION)) return false
    const left = deadline - this.deps.now()
    if (left <= 0) return false
    const res = await this.deps.lease(
      {
        backend: 'phone',
        width: info.width,
        height: info.height,
        label: workspaceLabel(info.sessionId),
      },
      left,
    )
    if (!res.ok) return false
    const { screen, lease } = res.value
    if (this.deps.now() > deadline) {
      lease.destroy()
      return false
    }
    const link: Link = {
      info,
      screenId: screen.id,
      lease,
      state: 'running',
      foreground: '',
      watching: false,
      polled: 0,
      frame: null,
    }
    this.links.set(info.linkId, link)
    readLines(lease, (message) => void this.call(link, message))
    lease.on('close', () => this.leaseClosed(link))
    this.deps.service.adopt({ ...screen, workspaceId: info.sessionId }, lease)
    this.asked.delete(info.sessionId)
    this.deps.changed(info.sessionId)
    return true
  }

  private async call(link: Link, message: Record<string, unknown>): Promise<void> {
    if (message.type !== 'call' || typeof message.method !== 'string') return
    const params = isRecord(message.params) ? message.params : {}
    const reply = await this.deps.phone.request(link.info.linkId, message.method as never, params)
    if (reply.ok) {
      write(link.lease, { type: 'reply', call: message.call, result: reply.data ?? {} })
      return
    }
    const reason = isRecord(reply.data) ? reply.data.reason : undefined
    write(link.lease, {
      type: 'reply',
      call: message.call,
      error: { code: reply.error, ...(typeof reason === 'string' ? { reason } : {}) },
    })
  }

  private event(event: PhoneScreenEvent): void {
    const link = this.links.get(event.linkId)
    if (!link) return
    if (event.kind === 'ended') {
      this.forget(link)
      link.lease.end()
      return
    }
    const payload = isRecord(event.payload) ? event.payload : {}
    if (event.kind === 'foreground') {
      link.foreground = plain(payload.label, LABEL_MAX)
    } else {
      link.state = payload.state === 'paused' ? 'paused' : 'running'
      write(link.lease, {
        type: 'state',
        state: payload.state,
        width: payload.width,
        height: payload.height,
      })
    }
    this.deps.changed(link.info.sessionId)
  }

  private frame(frame: PhoneScreenFrame): void {
    const link = this.links.get(frame.linkId)
    if (!link?.watching) return
    if (this.deps.now() - link.polled > WATCH_IDLE_MS) {
      void this.watch(link.screenId, false)
      return
    }
    link.frame = { seq: frame.header.seq, jpeg: frame.jpeg.toString('base64') }
  }

  private leaseClosed(link: Link): void {
    if (!this.forget(link)) return
    void this.deps.phone.request(link.info.linkId, 'phone.stop', {})
  }

  private forget(link: Link): boolean {
    if (this.links.get(link.info.linkId) !== link) return false
    this.links.delete(link.info.linkId)
    this.deps.changed(link.info.sessionId)
    return true
  }

  private byScreen(screenId: string): Link | undefined {
    for (const link of this.links.values()) if (link.screenId === screenId) return link
    return undefined
  }

  view(screenId: string): PhoneView | undefined {
    const link = this.byScreen(screenId)
    if (!link) return undefined
    return {
      device: plain(link.info.device.name, LABEL_MAX) || plain(link.info.label, LABEL_MAX),
      level: link.info.level,
      endsAt: link.info.endsAt,
      state: link.state,
      foreground: link.foreground,
      watching: link.watching,
    }
  }

  async watch(screenId: string, on: boolean): Promise<boolean> {
    const link = this.byScreen(screenId)
    if (!link) return false
    link.watching = on
    link.polled = this.deps.now()
    if (!on) link.frame = null
    const res = await this.deps.phone.request(link.info.linkId, 'phone.stream', {
      fps: on ? WATCH_FPS : 0,
      ...(on ? { maxSide: WATCH_MAX_SIDE } : {}),
    })
    return res.ok
  }

  latest(screenId: string): PhoneFrame | null {
    const link = this.byScreen(screenId)
    if (!link?.watching) return null
    link.polled = this.deps.now()
    return link.frame
  }

  linksIn(workspaceId: string): number {
    let count = 0
    for (const link of this.links.values()) if (link.info.sessionId === workspaceId) count += 1
    return count
  }

  async ask(workspaceId: string): Promise<boolean> {
    const res = await this.deps.phone.ask(workspaceId)
    if (res.ok) this.asked.set(workspaceId, this.deps.now())
    return res.ok
  }

  askedRecently(workspaceId: string): boolean {
    const at = this.asked.get(workspaceId)
    return at !== undefined && this.deps.now() - at < ASKED_MS
  }
}
