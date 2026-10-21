import { hostname } from 'node:os'
import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import { isEqual } from 'es-toolkit'
import type {
  GatewayActionResult,
  GatewayDevice,
  GatewayEnableResponse,
  GatewayPairResponse,
  GatewayPhoneAddress,
  GatewayRelayState,
  GatewayRemoteStatus,
  GatewaySetCapResult,
  GatewaySetPushResult,
  GatewaySetRouteResult,
  GatewayTailnetActionResult,
  GatewayTailnetState,
} from '../../shared/gateway/gatewayApi'
import { LOOPBACK_ADDRESS, resolveBindAddress } from '../../shared/gateway/gatewayRoute'
import { registerControlMethod } from '../control/controlServer'
import type { ServerAccount } from '../server/serverAccount'
import {
  type Announcement,
  type AnnouncementKey,
  announcementFor,
  lanAnnouncementFor,
  type Publisher,
} from './announce'
import { createBindFollower } from './bindFollower'
import type { Device } from './devices'
import {
  get as getDevice,
  list as listDevices,
  revoke as revokeDevice,
  setDeviceCap,
} from './devices'
import { listBindAddresses } from './interfaces'
import { liveCodeCount, newCode, onCodesChanged } from './pairing'
import { answerPairRequest, listPairRequests } from './pairRequests'
import { pushView } from './push/phonePush'
import type { RelayClient } from './relayClient'
import {
  checkRoute,
  friendlyName,
  loadDiscoverable,
  loadRoute,
  saveDiscoverable,
  saveRoute,
} from './route'
import {
  applyDeviceCaps,
  closeDeviceSockets,
  currentPhonePush,
  gatewayHelperPort,
  gatewayStatus,
  setTailnetNode,
  startGateway,
  stopGateway,
} from './server'
import { isAllowedLoginUrl, type Tailnet } from './tailnet'

export interface TailnetDeps {
  openExternal: (url: string) => void
}

let announcer: Publisher | null = null
let announced: Record<AnnouncementKey, Announcement | null> = { pairing: null, lan: null }

export function configureAnnouncer(publisher: Publisher): void {
  announcer = publisher
  announced = { pairing: null, lan: null }
}

function announce(key: AnnouncementKey, next: Announcement | null): void {
  if (isEqual(next, announced[key])) return
  announced[key] = next
  if (next) announcer?.publish(key, next)
  else announcer?.unpublish(key)
}

function refreshAnnouncement(): void {
  const status = gatewayStatus()
  const target = directTarget()
  announce(
    'pairing',
    announcementFor({
      discoverable: loadDiscoverable(),
      liveCodes: liveCodeCount(),
      name: friendlyName(),
      host: target?.host ?? null,
      port: target?.port ?? null,
      fingerprint: status.fingerprint,
    }),
  )
  announce(
    'lan',
    status.running
      ? lanAnnouncementFor({ name: friendlyName(), bindHost: status.host, port: status.port })
      : null,
  )
}

onCodesChanged(refreshAnnouncement)

let tailnet: Tailnet | null = null
let tailnetDeps: TailnetDeps = { openExternal: () => {} }

export function configureTailnet(instance: Tailnet, deps: TailnetDeps): void {
  tailnet = instance
  tailnetDeps = deps
}

let relay: RelayClient | null = null
let relayAccount: Pick<ServerAccount, 'signedIn'> | null = null

export function configureRelay(
  client: RelayClient,
  account: Pick<ServerAccount, 'signedIn'>,
): void {
  relay = client
  relayAccount = account
}

export function relayStatus(): GatewayRelayState {
  if (!loadRoute().relay) return { state: 'off' }
  if (!relayAccount?.signedIn()) return { state: 'needs-sign-in' }
  return relay?.status() ?? { state: 'off' }
}

export function onTailnetChange(state: GatewayTailnetState): void {
  setTailnetNode(state.state === 'running' ? { ip: state.ip, dnsName: state.dnsName } : null)
  refreshAnnouncement()
}

function toPhoneSafeDevice(d: Device): GatewayDevice {
  return {
    deviceId: d.deviceId,
    name: d.name,
    pubkey: d.pubkey,
    caps: d.caps,
    createdAt: d.createdAt,
    push: pushView(d),
  }
}

function tailnetState(): GatewayTailnetState {
  return tailnet?.state() ?? { state: 'off' }
}

export function remoteStatus(): GatewayRemoteStatus {
  return {
    ...gatewayStatus(),
    tailnet: tailnetState(),
    route: loadRoute(),
    relay: relayStatus(),
    discoverable: loadDiscoverable(),
    push: currentPhonePush()?.availability() ?? 'not-signed-in',
  }
}

const BIND_POLL_MS = 5000

async function startFromRoute(): Promise<boolean> {
  const route = loadRoute()
  const host = resolveBindAddress(listBindAddresses(), route)
  if (!host) return false
  const started = await startGateway({
    host,
    tailnet: route.tailnet,
    phoneAddress: route.tailnet ? null : route.phoneAddress,
    relay: route.relay,
  })
  if (route.tailnet && started.helperPort) {
    tailnet?.start({ helperPort: started.helperPort, port: started.port })
  }
  if (route.relay) relay?.start()
  refreshAnnouncement()
  return true
}

let wanted = false
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

async function rebindToCard(): Promise<void> {
  await serialized(async () => {
    if (!wanted) return
    relay?.stop()
    await tailnet?.stop()
    await stopGateway()
    try {
      if (wanted) await startFromRoute()
    } catch {
      await stopGateway()
    }
    refreshAnnouncement()
  })
}

const bindFollower = createBindFollower({
  everyMs: BIND_POLL_MS,
  resolve: () => resolveBindAddress(listBindAddresses(), loadRoute()),
  bound: () => gatewayStatus().host,
  rebind: rebindToCard,
})

export function enableRemote(): Promise<GatewayEnableResponse> {
  return serialized(async () => {
    if (!(await startFromRoute())) return { error: 'address-unavailable' }
    wanted = true
    if (loadRoute().bindInterface !== null) bindFollower.start()
    return remoteStatus()
  })
}

export async function stopRemote(): Promise<void> {
  wanted = false
  bindFollower.stop()
  relay?.stop()
  await tailnet?.stop()
}

function setRoute(value: unknown): GatewaySetRouteResult {
  if (gatewayStatus().running) return { ok: false, error: 'running' }
  const requested = typeof value === 'object' && value !== null ? value : {}
  const card = listBindAddresses().find(
    (a) => a.address === (requested as { bindAddress?: unknown }).bindAddress,
  )
  if (!card) return { ok: false, error: 'unknown-address' }
  const route = checkRoute({ ...requested, bindInterface: card.loopback ? null : card.iface })
  if (typeof route === 'string') return { ok: false, error: route }
  saveRoute(route)
  return { ok: true, route }
}

function directTarget(): GatewayPhoneAddress | null {
  const status = gatewayStatus()
  if (!status.running || !status.port) return null
  const route = loadRoute()
  if (route.tailnet) {
    const node = tailnetState()
    return node.state === 'running' && node.ip ? { host: node.ip, port: status.port } : null
  }
  if (route.phoneAddress) return route.phoneAddress
  if (!status.host || status.host === LOOPBACK_ADDRESS) return null
  return { host: status.host, port: status.port }
}

function relayTarget(): GatewayPhoneAddress | null {
  const state = relayStatus()
  return state.state === 'listening' ? { host: state.host, port: state.port } : null
}

function pairTarget(): GatewayPhoneAddress | null {
  return directTarget() ?? relayTarget()
}

export function disableRemote(): Promise<GatewayRemoteStatus> {
  wanted = false
  bindFollower.stop()
  return serialized(async () => {
    wanted = false
    bindFollower.stop()
    relay?.stop()
    await tailnet?.stop()
    await stopGateway()
    refreshAnnouncement()
    return remoteStatus()
  })
}

export function gatewayPair(): GatewayPairResponse {
  const status = gatewayStatus()
  const target = pairTarget()
  if (!status.fingerprint || !target) return { error: 'not-running' }
  return {
    v: 1,
    host: target.host,
    port: target.port,
    fingerprint: status.fingerprint,
    pairCode: newCode(),
    name: hostname(),
  }
}

function gatewayDevicesList(): { devices: GatewayDevice[] } {
  return { devices: listDevices().map(toPhoneSafeDevice) }
}

function gatewayRevoke(params: unknown): { ok: boolean; error?: string } {
  const { deviceId } = (params ?? {}) as { deviceId?: unknown }
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, error: 'missing-device-id' }
  }
  const handle = getDevice(deviceId)?.push?.handle
  if (!revokeDevice(deviceId)) return { ok: false, error: 'not-found' }
  closeDeviceSockets(deviceId)
  currentPhonePush()?.deviceRemoved(handle)
  return { ok: true }
}

export function gatewaySetCap(params: unknown): GatewaySetCapResult {
  const { deviceId, cap, granted } = (params ?? {}) as {
    deviceId?: unknown
    cap?: unknown
    granted?: unknown
  }
  if (typeof deviceId !== 'string' || !deviceId || typeof granted !== 'boolean') {
    return { ok: false, error: 'invalid-cap' }
  }
  const result = setDeviceCap(deviceId, cap, granted)
  if (result.ok) {
    currentPhonePush()?.capsChanged(deviceId)
    applyDeviceCaps(deviceId, result.caps)
  }
  return result
}

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

function setDiscoverable(value: unknown): GatewayActionResult {
  if (typeof value !== 'boolean') return { ok: false, error: 'invalid' }
  saveDiscoverable(value)
  refreshAnnouncement()
  return { ok: true }
}

function answerPair(params: unknown): GatewayActionResult {
  const { requestId, approve } = (params ?? {}) as { requestId?: unknown; approve?: unknown }
  if (typeof requestId !== 'string' || typeof approve !== 'boolean') {
    return { ok: false, error: 'invalid' }
  }
  const answer = answerPairRequest(requestId, approve)
  if (!answer) return { ok: false, error: 'invalid' }
  for (const deviceId of answer.replaced) closeDeviceSockets(deviceId)
  for (const handle of answer.replacedHandles) currentPhonePush()?.deviceRemoved(handle)
  return { ok: true }
}

function setDevicePush(params: unknown): Promise<GatewaySetPushResult> {
  const { deviceId, enabled } = (params ?? {}) as { deviceId?: unknown; enabled?: unknown }
  const push = currentPhonePush()
  if (typeof deviceId !== 'string' || typeof enabled !== 'boolean' || !push) {
    return Promise.resolve({ ok: false, error: 'invalid' })
  }
  return push.setEnabled(deviceId, enabled)
}

function tailnetSignIn(): GatewayTailnetActionResult {
  const node = tailnetState()
  if (node.state !== 'needs-login') return { ok: false, error: 'no-login-link' }
  if (!isAllowedLoginUrl(node.authUrl)) {
    return { ok: false, error: 'login-link-refused' }
  }
  tailnetDeps.openExternal(node.authUrl)
  return { ok: true }
}

async function tailnetSignOut(): Promise<GatewayTailnetActionResult> {
  if (!tailnet) return { ok: true }
  await tailnet.signOut()
  const helperPort = gatewayHelperPort()
  const port = gatewayStatus().port
  if (helperPort && port && loadRoute().tailnet) tailnet.start({ helperPort, port })
  return { ok: true }
}

export function registerGatewayMethods(): void {
  registerControlMethod('gateway.pair', {
    cap: 'gateway',
    handler: () => gatewayPair(),
  })

  registerControlMethod('gateway.status', {
    cap: 'gateway',
    handler: () => remoteStatus(),
  })

  registerControlMethod('gateway.devices', {
    cap: 'gateway',
    handler: () => gatewayDevicesList(),
  })

  registerControlMethod('gateway.revoke', {
    cap: 'gateway',
    handler: (params) => gatewayRevoke(params),
  })
}

export function registerGatewayIpc(): void {
  ipcMain.handle('gateway:enable', () => enableRemote())
  ipcMain.handle('gateway:disable', () => disableRemote())
  ipcMain.handle('gateway:pair', () => gatewayPair())
  ipcMain.handle('gateway:status', () => remoteStatus())
  ipcMain.handle('gateway:devices', () => gatewayDevicesList())
  ipcMain.handle('gateway:revoke', (_e, params) => gatewayRevoke(params))
  ipcMain.handle('gateway:set-cap', (e, params): GatewaySetCapResult => {
    if (!fromWindow(e)) return { ok: false, error: 'invalid-cap' }
    return gatewaySetCap(params)
  })
  ipcMain.handle('gateway:set-device-push', (e, params): Promise<GatewaySetPushResult> => {
    if (!fromWindow(e)) return Promise.resolve({ ok: false, error: 'not-a-window' })
    return setDevicePush(params)
  })
  ipcMain.handle('gateway:bind-addresses', () => listBindAddresses())
  ipcMain.handle('gateway:set-route', (e, params): GatewaySetRouteResult => {
    if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
    return setRoute(params)
  })
  ipcMain.handle('gateway:set-discoverable', (e, value): GatewayActionResult => {
    if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
    return setDiscoverable(value)
  })
  ipcMain.handle('gateway:pair-requests', () => listPairRequests())
  ipcMain.handle('gateway:pair-answer', (e, params): GatewayActionResult => {
    if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
    return answerPair(params)
  })
  ipcMain.handle('gateway:tailnet-sign-in', (e): GatewayTailnetActionResult => {
    if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
    return tailnetSignIn()
  })
  ipcMain.handle('gateway:tailnet-sign-out', (e): Promise<GatewayTailnetActionResult> => {
    if (!fromWindow(e)) return Promise.resolve({ ok: false, error: 'not-a-window' })
    return tailnetSignOut()
  })
}
