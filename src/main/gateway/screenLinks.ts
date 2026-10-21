import { randomUUID } from 'node:crypto'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  PHONE_SCREEN_ASK_REASON_MAX,
  PHONE_SCREEN_INPUT_REQUESTS,
  PHONE_SCREEN_LIMITS_SEC,
  PHONE_SCREEN_REQUEST_MS,
  PHONE_SCREEN_REQUESTS,
  PHONE_SCREEN_ROTATIONS,
  type PhoneScreenDeclineReason,
  type PhoneScreenEndReason,
  type PhoneScreenEvent,
  type PhoneScreenFrameHeader,
  type PhoneScreenLink,
  type PhoneScreenReply,
  type PhoneScreenRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import { oneLine } from '../../shared/agents/questions'
import { resolveExternal } from '../control/idRegistry'
import type { WorkspaceEntry } from '../panes/paneList'
import type { RpcOutcome } from './controlDispatch'
import type { Device } from './devices'
import { type ScreenRequested, ScreenRequests, type ScreenRequestTiming } from './screenRequests'

const FRAME_PHONE_SCREEN = 0x10

const MAX_SIDE = 10_000
const MAX_DENSITY = 1_000
const LABEL_MAX = 200
const START_SKEW_MS = 30_000
const FRAME_HEADER_MAX = 4_096
const FRAMES_PER_SECOND = 5

const CLOSE_REASONS: Partial<Record<number, PhoneScreenEndReason>> = {
  4003: 'revoked',
  4004: 'caps-changed',
  4005: 'time-limit',
  4006: 'no-controller',
}

export interface LinkSocket {
  readonly readyState: number
  readonly OPEN: number
  send(data: string): void
  close(code: number, reason: string): void
}

export interface ScreenLinkController {
  offer(link: PhoneScreenLink): Promise<boolean>
  frame(linkId: string, header: PhoneScreenFrameHeader, jpeg: Buffer): void
  event(event: PhoneScreenEvent): void
}

export interface ScreenLinkTiming {
  offerMs: number
  requestMs: number
  graceMs: number
}

export interface ScreenLinksDeps {
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  askPhones: (request: ScreenRequested, deviceIds?: string[]) => void
  notifiedDevices: () => string[]
  agentRunning: (paneId: string) => boolean
  log: (event: string, fields: Record<string, string>) => void
  now?: () => number
  timing?: ScreenLinkTiming
  requestTiming?: ScreenRequestTiming
}

interface Pending {
  resolve: (reply: PhoneScreenReply) => void
  timer: ReturnType<typeof setTimeout>
}

interface Link {
  info: PhoneScreenLink
  ws: LinkSocket
  controller: ScreenLinkController | null
  active: boolean
  nextId: number
  pending: Map<number, Pending>
  frames: number[]
  endTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_TIMING: ScreenLinkTiming = {
  offerMs: 5_000,
  requestMs: PHONE_SCREEN_REQUEST_MS,
  graceMs: 5_000,
}

function refused(message: string, code = -32602): RpcOutcome {
  return { ok: false, code, message }
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function oneOf<T>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.includes(value as T)
}

function parseStart(
  params: unknown,
  now: number,
): Omit<PhoneScreenLink, 'linkId' | 'device'> | null {
  if (!isRecord(params)) return null
  const { sessionId, width, height, density, rotation, level, limitSec, endsAt } = params
  const { overlayHeight, label, agent } = params
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (!isInt(width, 1, MAX_SIDE) || !isInt(height, 1, MAX_SIDE)) return null
  if (typeof density !== 'number' || !(density > 0 && density <= MAX_DENSITY)) return null
  if (!oneOf(rotation, PHONE_SCREEN_ROTATIONS) || !oneOf(level, ['view', 'control'] as const)) {
    return null
  }
  if (!oneOf(limitSec, PHONE_SCREEN_LIMITS_SEC)) return null
  if (typeof endsAt !== 'number' || endsAt <= now) return null
  if (endsAt > now + limitSec * 1000 + START_SKEW_MS) return null
  if (!isInt(overlayHeight, 0, height)) return null
  if (typeof label !== 'string' || label.length > LABEL_MAX) return null
  if (agent !== undefined && !oneOf(agent, ['claude', 'codex'] as const)) return null
  return {
    sessionId,
    width,
    height,
    density,
    rotation,
    level,
    limitSec,
    endsAt,
    overlayHeight,
    label,
    ...(agent ? { agent } : {}),
  }
}

function parseFrameHeader(raw: Buffer): PhoneScreenFrameHeader | null {
  let header: unknown
  try {
    header = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(header)) return null
  const { seq, width, height, screenWidth, screenHeight, blocked } = header
  if (!isInt(seq, 0, Number.MAX_SAFE_INTEGER) || typeof blocked !== 'boolean') return null
  const sides = [width, height, screenWidth, screenHeight]
  if (!sides.every((side) => isInt(side, 1, MAX_SIDE))) return null
  return {
    seq,
    width: width as number,
    height: height as number,
    screenWidth: screenWidth as number,
    screenHeight: screenHeight as number,
    blocked,
  }
}

function linkable(workspace: WorkspaceEntry | undefined): boolean {
  return workspace !== undefined && workspace.kind !== 'scratch' && workspace.kind !== 'manager'
}

function phoneReply(msg: Record<string, unknown>): PhoneScreenReply {
  if (!('error' in msg)) return { ok: true, data: msg.result }
  const error = isRecord(msg.error) ? msg.error : {}
  const code = typeof error.message === 'string' ? error.message : 'failed'
  return error.data === undefined
    ? { ok: false, error: code }
    : { ok: false, error: code, data: error.data }
}

async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([work.catch(() => fallback), deadline])
  } finally {
    clearTimeout(timer)
  }
}

export class ScreenLinks {
  private controller: ScreenLinkController | null = null
  private readonly links = new Map<LinkSocket, Link>()
  private readonly ended = new WeakSet<LinkSocket>()
  private readonly timing: ScreenLinkTiming
  private readonly requests: ScreenRequests

  constructor(private readonly deps: ScreenLinksDeps) {
    this.timing = deps.timing ?? DEFAULT_TIMING
    this.requests = new ScreenRequests(
      () => deps.notifiedDevices(),
      (request, deviceIds) => deps.askPhones(request, deviceIds),
      () => this.now(),
      deps.requestTiming,
    )
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  isLink(ws: LinkSocket): boolean {
    return this.links.has(ws) || this.ended.has(ws)
  }

  listen(controller: ScreenLinkController): boolean {
    if (this.controller && this.controller !== controller) return false
    this.controller = controller
    return true
  }

  release(controller: ScreenLinkController): void {
    if (this.controller !== controller) return
    this.controller = null
    for (const link of [...this.links.values()]) this.end(link, 'no-controller', 4006)
  }

  async start(
    ws: LinkSocket,
    device: Pick<Device, 'deviceId' | 'name' | 'caps'>,
    params: unknown,
  ): Promise<RpcOutcome> {
    if (!device.caps.includes('read')) {
      return { ok: false, code: -32003, message: 'needs-elevation', data: { cap: 'read' } }
    }
    if (this.isLink(ws)) return refused('busy')
    const parsed = parseStart(params, this.now())
    if (!parsed) return refused('bad-params')
    const links = [...this.links.values()]
    if (links.some((link) => link.info.device.id === device.deviceId)) return refused('busy')
    const link: Link = {
      info: { ...parsed, linkId: randomUUID(), device: { id: device.deviceId, name: device.name } },
      ws,
      controller: null,
      active: false,
      nextId: 1,
      pending: new Map(),
      frames: [],
      endTimer: null,
    }
    this.links.set(ws, link)
    const refusal = await this.admit(link)
    if (this.links.get(ws) !== link) {
      link.controller?.event({
        linkId: link.info.linkId,
        kind: 'ended',
        payload: { reason: 'closed' },
      })
      return refused('closed')
    }
    if (refusal) {
      this.links.delete(ws)
      return refusal
    }
    link.active = true
    const left = link.info.endsAt + this.timing.graceMs - this.now()
    link.endTimer = setTimeout(() => this.end(link, 'time-limit', 4005), Math.max(0, left))
    this.deps.log('phone-screen-link', { linkId: link.info.linkId, state: 'started' })
    const requestId = isRecord(params) ? params.requestId : undefined
    if (typeof requestId === 'string') {
      this.requests.started(requestId, device.deviceId, link.info.sessionId)
    }
    return { ok: true, result: { screenId: link.info.linkId } }
  }

  private async admit(link: Link): Promise<RpcOutcome | null> {
    const workspaces = await this.deps.listWorkspaces().catch(() => [])
    const workspace = workspaces.find((w) => w.workspaceId === link.info.sessionId)
    if (!linkable(workspace)) return refused('unknown-session')
    const controller = this.controller
    if (!controller) return refused('no-controller', -32004)
    const accepted = await within(controller.offer(link.info), this.timing.offerMs, false)
    if (accepted !== true || this.controller !== controller) {
      return refused('no-controller', -32004)
    }
    link.controller = controller
    return null
  }

  private linkFor(controller: ScreenLinkController, linkId: string): Link | null {
    if (controller !== this.controller) return null
    for (const link of this.links.values()) {
      if (link.info.linkId === linkId && link.active && link.controller === controller) return link
    }
    return null
  }

  request(
    controller: ScreenLinkController,
    linkId: string,
    method: string,
    params: unknown,
  ): Promise<PhoneScreenReply> {
    const link = this.linkFor(controller, linkId)
    if (!link) return Promise.resolve({ ok: false, error: 'unknown-link' })
    if (!oneOf(method, PHONE_SCREEN_REQUESTS)) {
      return Promise.resolve({ ok: false, error: 'unknown-method' })
    }
    if (params !== undefined && !isRecord(params)) {
      return Promise.resolve({ ok: false, error: 'bad-params' })
    }
    if (link.info.level === 'view' && PHONE_SCREEN_INPUT_REQUESTS.includes(method)) {
      return Promise.resolve({ ok: false, error: 'view-only' })
    }
    return this.send(link, method, params ?? {})
  }

  private send(
    link: Link,
    method: PhoneScreenRequest,
    params: Record<string, unknown>,
  ): Promise<PhoneScreenReply> {
    const id = link.nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        link.pending.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, this.timing.requestMs)
      link.pending.set(id, { resolve, timer })
      link.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async ask(controller: ScreenLinkController, sessionId: string): Promise<PhoneScreenReply> {
    if (controller !== this.controller) return { ok: false, error: 'not-listening' }
    const workspaces = await this.deps.listWorkspaces().catch(() => [])
    const workspace = workspaces.find((w) => w.workspaceId === sessionId)
    if (!linkable(workspace)) return { ok: false, error: 'unknown-session' }
    this.deps.askPhones({ sessionId, by: 'desktop' })
    return { ok: true, data: null }
  }

  async askFor(controller: ScreenLinkController, raw: unknown): Promise<PhoneScreenReply> {
    if (controller !== this.controller) return { ok: false, error: 'not-listening' }
    const params = isRecord(raw) ? raw : {}
    const { sessionId, pane, reason, agent } = params
    if (typeof sessionId !== 'string' || typeof pane !== 'string') {
      return { ok: false, error: 'invalid-params' }
    }
    const text = typeof reason === 'string' ? oneLine(reason) : ''
    if (!text || text.length > PHONE_SCREEN_ASK_REASON_MAX) {
      return { ok: false, error: 'invalid-reason' }
    }
    if (agent !== undefined && agent !== 'claude' && agent !== 'codex') {
      return { ok: false, error: 'invalid-params' }
    }
    const asker = resolveExternal(pane)
    if (asker?.kind !== 'pane' || asker.manager || asker.workspaceId !== sessionId) {
      return { ok: false, error: 'unknown-pane' }
    }
    if (!this.deps.agentRunning(asker.paneId)) return { ok: false, error: 'not-an-agent' }
    const workspaces = await this.deps.listWorkspaces().catch(() => [])
    if (!linkable(workspaces.find((w) => w.workspaceId === sessionId))) {
      return { ok: false, error: 'unknown-session' }
    }
    const asked = this.requests.askFromAgent({
      sessionId,
      reason: text,
      pane: asker.externalId,
      ...(agent ? { agent } : {}),
    })
    if (!asked.ok) return { ok: false, error: asked.error }
    return { ok: true, data: await asked.answer }
  }

  deviceGone(deviceId: string): void {
    this.requests.dropDevice(deviceId)
  }

  decline(requestId: string, deviceId: string, reason: PhoneScreenDeclineReason): boolean {
    return this.requests.decline(requestId, deviceId, reason)
  }

  fromPhone(ws: LinkSocket, msg: Record<string, unknown>): boolean {
    const link = this.links.get(ws)
    if (!link) return this.ended.has(ws)
    if (msg.method === undefined && ('result' in msg || 'error' in msg)) {
      const pending = typeof msg.id === 'number' ? link.pending.get(msg.id) : undefined
      if (pending) {
        link.pending.delete(msg.id as number)
        clearTimeout(pending.timer)
        pending.resolve(phoneReply(msg))
      }
      return true
    }
    if (msg.method !== 'event') return false
    const params = isRecord(msg.params) ? msg.params : {}
    const kind =
      params.type === 'screen.state'
        ? 'state'
        : params.type === 'screen.foreground'
          ? 'foreground'
          : null
    if (kind && link.active) {
      link.controller?.event({ linkId: link.info.linkId, kind, payload: params.payload })
    }
    return true
  }

  frame(ws: LinkSocket, data: Buffer): void {
    const link = this.links.get(ws)
    if (!link?.active || !link.controller || data.length < 5 || data[0] !== FRAME_PHONE_SCREEN) {
      return
    }
    const now = this.now()
    link.frames = link.frames.filter((at) => now - at < 1000)
    if (link.frames.length >= FRAMES_PER_SECOND) return
    const headerLength = data.readUInt32BE(1)
    if (headerLength > FRAME_HEADER_MAX || 5 + headerLength >= data.length) return
    const header = parseFrameHeader(data.subarray(5, 5 + headerLength))
    if (!header) return
    link.frames.push(now)
    link.controller.frame(link.info.linkId, header, data.subarray(5 + headerLength))
  }

  closed(ws: LinkSocket, code: number): void {
    const link = this.links.get(ws)
    if (link) this.end(link, CLOSE_REASONS[code] ?? 'closed')
  }

  private end(link: Link, reason: PhoneScreenEndReason, closeCode?: number): void {
    if (this.links.get(link.ws) !== link) return
    this.links.delete(link.ws)
    this.ended.add(link.ws)
    if (link.endTimer) clearTimeout(link.endTimer)
    for (const pending of link.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: 'link-ended' })
    }
    link.pending.clear()
    if (link.active) {
      link.controller?.event({ linkId: link.info.linkId, kind: 'ended', payload: { reason } })
      this.deps.log('phone-screen-link', { linkId: link.info.linkId, state: 'ended', reason })
    }
    if (closeCode !== undefined) link.ws.close(closeCode, reason)
  }
}
