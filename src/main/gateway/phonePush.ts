import type { GatewayPushAvailability, GatewaySetPushResult } from '../../shared/gateway/gatewayApi'
import { failureOf, type ServerAccount } from '../server/serverAccount'
import { ServerError } from '../server/serverClient'
import { type Device, type DevicePush, isPushHandle, isPushPlatform, pushOf } from './devices'

const PUSH_EVENTS: ReadonlySet<string> = new Set(['agent.needs-input', 'ask.created', 'notify'])

const PING_GAP_MS = 30_000
const PINGS_PER_HOUR = 60
const HOUR_MS = 3_600_000
const DEFAULT_BACKOFF_S = 30
const OFFER_TTL_MS = 600_000
const TICKETS_PER_WINDOW = 3
const TICKET_WINDOW_MS = 600_000

export interface PushConfig {
  server: string | null
  registered?: boolean
}

export type PushTicketResult =
  | { ok: true; ticket: string; expiresAt: number }
  | { ok: false; error: 'push-off' | 'rate-limited' | 'server-unavailable' }

export type PushRegisterResult = { ok: true } | { ok: false; error: 'push-off' | 'bad-params' }

export interface PhonePushDeps {
  account: Pick<ServerAccount, 'signedIn' | 'baseUrl' | 'authed' | 'fetchInfo' | 'onChange'>
  devices: {
    list: () => Device[]
    get: (deviceId: string) => Device | null
    setPush: (deviceId: string, push: DevicePush) => boolean
  }
  connected: (deviceId: string) => boolean
  sendConfig: (deviceId: string, config: PushConfig) => void
  changed: () => void
  now?: () => number
  log?: (event: string, fields: Record<string, string>) => void
}

interface PingState {
  last: number
  recent: number[]
  blockedUntil: number
}

export class PhonePush {
  private offered: boolean | null = null
  private offeredAt = 0
  private refreshing: Promise<void> | null = null
  private readonly pings = new Map<string, PingState>()
  private readonly tickets = new Map<string, number[]>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: PhonePushDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.account.onChange(() => this.accountChanged())
    void this.refreshOffer()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  availability(): GatewayPushAvailability {
    if (!this.deps.account.signedIn()) return 'not-signed-in'
    if (this.offered === null) return 'unreachable'
    return this.offered ? 'available' : 'server-push-off'
  }

  private active(device: Device | null): device is Device {
    return device !== null && pushOf(device).enabled && this.availability() === 'available'
  }

  private configOf(device: Device): PushConfig {
    const server = this.deps.account.baseUrl()
    if (!this.active(device) || !server) return { server: null }
    return { server, registered: pushOf(device).handle !== undefined }
  }

  hello(device: Device): { server: string; registered: boolean } | undefined {
    if (this.now() - this.offeredAt > OFFER_TTL_MS) void this.refreshOffer()
    const config = this.configOf(device)
    return config.server === null
      ? undefined
      : { server: config.server, registered: config.registered === true }
  }

  private announce(deviceId: string): void {
    const device = this.deps.devices.get(deviceId)
    if (device) this.deps.sendConfig(deviceId, this.configOf(device))
  }

  private announceAll(): void {
    for (const device of this.deps.devices.list()) {
      if (pushOf(device).enabled) this.announce(device.deviceId)
    }
  }

  refreshOffer(): Promise<void> {
    if (!this.deps.account.signedIn()) {
      this.offered = null
      return Promise.resolve()
    }
    this.refreshing ??= this.deps.account
      .fetchInfo()
      .then(
        (info) => info.modules.push === true,
        () => null,
      )
      .then((offered) => {
        const before = this.availability()
        this.offered = offered
        this.offeredAt = this.now()
        if (this.availability() !== before) {
          this.announceAll()
          this.deps.changed()
        }
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  private accountChanged(): void {
    if (!this.deps.account.signedIn()) {
      this.offered = null
      this.pings.clear()
      for (const device of this.deps.devices.list()) {
        const push = pushOf(device)
        if (push.handle) this.deps.devices.setPush(device.deviceId, { enabled: push.enabled })
      }
      this.announceAll()
      this.deps.changed()
      return
    }
    void this.refreshOffer()
  }

  async setEnabled(deviceId: string, enabled: boolean): Promise<GatewaySetPushResult> {
    const device = this.deps.devices.get(deviceId)
    if (!device) return { ok: false, error: 'not-found' }
    const push = pushOf(device)
    if (enabled) {
      if (!device.caps.includes('notify')) return { ok: false, error: 'needs-notify' }
      await this.refreshOffer()
      const availability = this.availability()
      if (availability !== 'available') return { ok: false, error: availability }
      if (!push.enabled) this.deps.devices.setPush(deviceId, { enabled: true })
    } else {
      this.deps.devices.setPush(deviceId, { enabled: false })
      this.dropRemote(push.handle)
    }
    this.announce(deviceId)
    this.deps.changed()
    return { ok: true }
  }

  async ticket(deviceId: string): Promise<PushTicketResult> {
    if (!this.active(this.deps.devices.get(deviceId))) return { ok: false, error: 'push-off' }
    const now = this.now()
    const recent = (this.tickets.get(deviceId) ?? []).filter((at) => now - at < TICKET_WINDOW_MS)
    this.tickets.set(deviceId, [...recent, now])
    if (recent.length >= TICKETS_PER_WINDOW) return { ok: false, error: 'rate-limited' }
    try {
      const minted = await this.deps.account.authed((token, routes) => routes.pushTicket(token))
      return { ok: true, ticket: minted.ticket, expiresAt: minted.expiresAt }
    } catch (error) {
      return {
        ok: false,
        error: failureOf(error) === 'rate-limited' ? 'rate-limited' : 'server-unavailable',
      }
    }
  }

  register(deviceId: string, handle: unknown, platform: unknown): PushRegisterResult {
    const device = this.deps.devices.get(deviceId)
    if (!this.active(device)) return { ok: false, error: 'push-off' }
    if (!isPushHandle(handle) || !isPushPlatform(platform))
      return { ok: false, error: 'bad-params' }
    const previous = pushOf(device).handle
    this.deps.devices.setPush(deviceId, { enabled: true, handle, platform })
    if (previous && previous !== handle) this.dropRemote(previous)
    this.deps.changed()
    return { ok: true }
  }

  unregister(deviceId: string): { ok: true } {
    const device = this.deps.devices.get(deviceId)
    const push = device ? pushOf(device) : null
    if (device && push?.handle) {
      this.deps.devices.setPush(deviceId, { enabled: push.enabled })
      this.dropRemote(push.handle)
      this.deps.changed()
    }
    return { ok: true }
  }

  deviceRemoved(handle: string | undefined): void {
    this.dropRemote(handle)
  }

  private dropRemote(handle: string | undefined): void {
    if (!handle) return
    this.pings.delete(handle)
    this.deps.account
      .authed((token, routes) => routes.pushDelete(token, handle))
      .catch((error: unknown) => this.deps.log?.('push.delete-failed', { reason: reasonOf(error) }))
  }

  async event(type: string): Promise<void> {
    if (!PUSH_EVENTS.has(type)) return
    const pings: Promise<void>[] = []
    for (const device of this.deps.devices.list()) {
      const push = pushOf(device)
      if (!push.handle || !device.caps.includes('notify') || !this.active(device)) continue
      if (this.deps.connected(device.deviceId)) continue
      pings.push(this.ping(device.deviceId, push.handle))
    }
    await Promise.all(pings)
  }

  private permitted(handle: string): boolean {
    const now = this.now()
    const state = this.pings.get(handle) ?? { last: 0, recent: [], blockedUntil: 0 }
    const recent = state.recent.filter((at) => now - at < HOUR_MS)
    const allowed =
      now - state.last >= PING_GAP_MS && now >= state.blockedUntil && recent.length < PINGS_PER_HOUR
    this.pings.set(
      handle,
      allowed ? { ...state, last: now, recent: [...recent, now] } : { ...state, recent },
    )
    return allowed
  }

  private async ping(deviceId: string, handle: string): Promise<void> {
    if (!this.permitted(handle)) return
    try {
      await this.deps.account.authed((token, routes) => routes.pushPing(token, handle))
    } catch (error) {
      this.pingFailed(deviceId, handle, error)
    }
  }

  private pingFailed(deviceId: string, handle: string, error: unknown): void {
    if (error instanceof ServerError && error.status === 429) {
      const state = this.pings.get(handle)
      if (state) {
        state.blockedUntil = this.now() + (error.retryAfter ?? DEFAULT_BACKOFF_S) * 1000
      }
      return
    }
    if (error instanceof ServerError && error.status === 410) {
      this.handleGone(deviceId, handle)
      return
    }
    this.deps.log?.('push.ping-failed', { reason: reasonOf(error) })
  }

  private handleGone(deviceId: string, handle: string): void {
    const device = this.deps.devices.get(deviceId)
    if (!device || pushOf(device).handle !== handle) return
    this.pings.delete(handle)
    this.deps.devices.setPush(deviceId, { enabled: true })
    this.announce(deviceId)
    this.deps.changed()
  }
}

function reasonOf(error: unknown): string {
  return error instanceof ServerError ? `${error.status}` : 'failed'
}

export function pushView(device: Device): { enabled: boolean; registered: boolean } {
  const push = pushOf(device)
  return { enabled: push.enabled, registered: push.handle !== undefined }
}
