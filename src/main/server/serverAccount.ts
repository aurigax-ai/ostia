import type {
  GithubPollResult,
  GithubStartResult,
  ServerActionResult,
  ServerDevicesResult,
  ServerFailure,
  ServerInfoResult,
  ServerStatus,
} from '../../shared/server/serverApi'
import { type DeviceKeys, generateDeviceKeys, registrationOf } from './deviceKeys'
import type { DeviceSigner } from './deviceSigner'
import type { KeyStore } from './keyStore'
import { ServerError } from './serverClient'
import type { ServerConfig, ServerIdentity } from './serverConfig'
import type {
  DeviceRegistered,
  GithubFlow,
  RelayLabel,
  ServerInfo,
  ServerRoutes,
} from './serverRoutes'
import type { ServerSession } from './serverSession'
import { hostOf } from './serverUrl'

const NAME_MAX = 64
const MS = 1000

export interface AccountDeps {
  config: ServerConfig
  keyStore: KeyStore
  routes: ServerRoutes
  session: ServerSession
  signer: DeviceSigner
  deviceName: () => string
  now?: () => number
}

interface ActiveFlow {
  flow: GithubFlow
  keys: DeviceKeys
  name: string
  nextPollAt: number
  interval: number
}

const REFUSALS: Record<string, ServerFailure> = {
  'elevation-required': 'elevation-required',
  'device-too-new': 'device-too-new',
  'requester-too-new': 'requester-too-new',
  'no-second-device': 'no-second-device',
  'not-a-github-account': 'not-a-github-account',
  'stale-signature': 'stale-signature',
}

const refusalOf = (code: string): ServerFailure => REFUSALS[code] ?? 'failed'

export function failureOf(error: unknown): ServerFailure {
  if (!(error instanceof ServerError)) return 'failed'
  if (error.code === 'no-server') return 'no-server'
  if (error.code === 'not-signed-in') return 'not-signed-in'
  if (error.status === 0) return 'unreachable'
  if (error.status === 429) return 'rate-limited'
  if (error.status === 401) return 'not-signed-in'
  if (error.code === 'invalid-invite') return 'invalid-invite'
  if (error.code === 'device-limit') return 'device-limit'
  if (error.status === 507 || error.code === 'quota-exceeded') return 'quota'
  if (error.status === 403 || error.status === 409) return refusalOf(error.code)
  if (error.status === 404 || error.status >= 500) return 'unavailable'
  return 'failed'
}

export function cleanDeviceName(raw: string): string {
  const printable = Array.from(raw)
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .trim()
  return Array.from(printable).slice(0, NAME_MAX).join('') || 'Ostia'
}

export class ServerAccount {
  private flow: ActiveFlow | null = null
  private readonly listeners = new Set<() => void>()
  private readonly deviceListeners = new Set<() => void>()
  private readonly signOutHooks = new Set<() => void>()

  constructor(private readonly deps: AccountDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    for (const cb of this.listeners) cb()
  }

  beforeSignOut(cb: () => void): void {
    this.signOutHooks.add(cb)
  }

  onDevicesChanged(cb: () => void): () => void {
    this.deviceListeners.add(cb)
    return () => this.deviceListeners.delete(cb)
  }

  devicesChanged(): void {
    for (const cb of this.deviceListeners) cb()
  }

  signedIn(): boolean {
    return this.deps.config.identity() !== null
  }

  status(): ServerStatus {
    const url = this.deps.config.url()
    const identity = this.deps.config.identity()
    return {
      url,
      host: url ? hostOf(url) : null,
      signedIn: identity !== null,
      provider: identity?.provider ?? null,
      deviceName: identity?.deviceName ?? null,
    }
  }

  setUrl(url: string | null): ServerActionResult {
    if (this.signedIn()) return { ok: false, error: 'already-signed-in' }
    this.flow = null
    this.deps.config.setUrl(url)
    this.changed()
    return { ok: true }
  }

  async info(): Promise<ServerInfoResult> {
    try {
      const info = await this.deps.routes.info()
      return {
        ok: true,
        offer: { ...info.modules, invite: info.auth.invite, github: info.auth.github },
      }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  fetchInfo(): Promise<ServerInfo> {
    return this.deps.routes.info()
  }

  private begin(): { keys: DeviceKeys; name: string } | ServerFailure {
    if (this.signedIn()) return 'already-signed-in'
    if (!this.deps.config.url()) return 'no-server'
    if (!this.deps.keyStore.available()) return 'unavailable'
    return { keys: generateDeviceKeys(), name: cleanDeviceName(this.deps.deviceName()) }
  }

  private finish(registered: DeviceRegistered, keys: DeviceKeys, name: string): boolean {
    if (!this.deps.keyStore.save(keys)) return false
    this.deps.config.setIdentity({
      accountId: registered.accountId,
      deviceId: registered.deviceId,
      provider: registered.provider,
      deviceName: name,
    })
    this.changed()
    return true
  }

  async signInWithInvite(code: string): Promise<ServerActionResult> {
    const started = this.begin()
    if (typeof started === 'string') return { ok: false, error: started }
    const { keys, name } = started
    try {
      const registered = await this.deps.routes.registerWithInvite(
        code.trim(),
        name,
        registrationOf(keys),
      )
      if (!this.finish(registered, keys, name)) return { ok: false, error: 'unavailable' }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async githubStart(): Promise<GithubStartResult> {
    const started = this.begin()
    if (typeof started === 'string') return { ok: false, error: started }
    try {
      const flow = await this.deps.routes.githubDevice()
      this.flow = {
        flow,
        ...started,
        interval: flow.interval,
        nextPollAt: this.now() + flow.interval * MS,
      }
      return { ok: true, userCode: flow.userCode, verificationUri: flow.verificationUri }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  verificationUri(): string | null {
    const uri = this.flow?.flow.verificationUri
    return uri?.startsWith('https://') ? uri : null
  }

  githubCancel(): void {
    this.flow = null
  }

  async githubPoll(): Promise<GithubPollResult> {
    const active = this.flow
    if (!active) return { state: 'error', error: 'failed' }
    if (this.now() < active.nextPollAt) return { state: 'pending' }
    try {
      const polled = await this.deps.routes.githubPoll(
        active.flow.flowId,
        active.name,
        registrationOf(active.keys),
      )
      if (this.flow !== active) return { state: 'error', error: 'failed' }
      if (polled.status === 'pending') {
        active.interval = polled.interval
        active.nextPollAt = this.now() + polled.interval * MS
        return { state: 'pending' }
      }
      this.flow = null
      if (!this.finish(polled, active.keys, active.name)) {
        return { state: 'error', error: 'unavailable' }
      }
      return { state: 'done' }
    } catch (error) {
      if (this.flow !== active) return { state: 'error', error: 'failed' }
      if (error instanceof ServerError && error.status === 403 && error.code === 'denied') {
        this.flow = null
        return { state: 'error', error: 'denied' }
      }
      if (error instanceof ServerError && (error.status === 410 || error.code === 'unknown-flow')) {
        this.flow = null
        return { state: 'error', error: 'expired' }
      }
      if (error instanceof ServerError && error.status === 429) {
        active.nextPollAt = this.now() + (error.retryAfter ?? active.interval) * MS
        return { state: 'pending' }
      }
      return { state: 'error', error: failureOf(error) }
    }
  }

  async signOut(): Promise<ServerActionResult> {
    for (const hook of this.signOutHooks) hook()
    await this.deps.session.end()
    this.deps.config.setIdentity(null)
    this.deps.keyStore.erase()
    this.deps.session.forget()
    this.flow = null
    this.changed()
    return { ok: true }
  }

  async devices(): Promise<ServerDevicesResult> {
    if (!this.signedIn()) return { ok: false, error: 'not-signed-in' }
    try {
      const { devices } = await this.deps.session.authed((token) => this.deps.routes.devices(token))
      return {
        ok: true,
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          current: d.current === true,
          lastSeen: d.lastSeen,
          createdAt: d.createdAt,
          isNew: d.new === true,
        })),
      }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  identity(): ServerIdentity | null {
    return this.deps.config.identity()
  }

  deviceKeys(): DeviceKeys | null {
    return this.signedIn() ? this.deps.keyStore.load() : null
  }

  signer(): DeviceSigner {
    return this.deps.signer
  }

  authed<T>(use: (token: string, routes: ServerRoutes) => Promise<T>): Promise<T> {
    return this.deps.session.authed((token) => use(token, this.deps.routes))
  }

  unauthed<T>(use: (routes: ServerRoutes) => Promise<T>): Promise<T> {
    return use(this.deps.routes)
  }

  relayLabel(): Promise<RelayLabel> {
    return this.deps.session.authed((token) => this.deps.routes.relayLabel(token))
  }

  baseUrl(): string | null {
    return this.deps.config.url()
  }

  session(): ServerSession {
    return this.deps.session
  }
}
