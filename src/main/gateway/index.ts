import { hostname } from 'node:os'
import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import { LOOPBACK_ADDRESS } from '../../shared/gatewayRoute'
import type {
  GatewayActionResult,
  GatewayDevice,
  GatewayEnableResponse,
  GatewayPairResponse,
  GatewayPhoneAddress,
  GatewayRemoteStatus,
  GatewaySetCapResult,
  GatewaySetRouteResult,
  GatewayTailnetActionResult,
  GatewayTailnetState,
} from '../../shared/types'
import { registerControlMethod } from '../control/controlServer'
import { type Announcement, type Publisher, announcementFor, sameAnnouncement } from './announce'
import type { Device } from './devices'
import { list as listDevices, revoke as revokeDevice, setDeviceCap } from './devices'
import { listBindAddresses } from './interfaces'
import { answerPairRequest, listPairRequests } from './pairRequests'
import { liveCodeCount, newCode, onCodesChanged } from './pairing'
import { checkRoute, loadDiscoverable, loadRoute, saveDiscoverable, saveRoute } from './route'
import {
  applyDeviceCaps,
  closeDeviceSockets,
  gatewayHelperPort,
  gatewayStatus,
  setTailnetHosts,
  startGateway,
  stopGateway,
} from './server'
import { type Tailnet, isAllowedLoginUrl } from './tailnet'

export interface TailnetDeps {
  openExternal: (url: string) => void
}

let announcer: Publisher | null = null
let announced: Announcement | null = null

export function configureAnnouncer(publisher: Publisher): void {
  announcer = publisher
  announced = null
}

function refreshAnnouncement(): void {
  const status = gatewayStatus()
  const target = pairTarget()
  const next = announcementFor({
    discoverable: loadDiscoverable(),
    liveCodes: liveCodeCount(),
    name: hostname(),
    host: target?.host ?? null,
    port: target?.port ?? null,
    fingerprint: status.fingerprint,
  })
  if (sameAnnouncement(next, announced)) return
  announced = next
  if (next) announcer?.publish(next)
  else announcer?.unpublish()
}

onCodesChanged(refreshAnnouncement)

let tailnet: Tailnet | null = null
let tailnetDeps: TailnetDeps = { openExternal: () => {} }

export function configureTailnet(instance: Tailnet, deps: TailnetDeps): void {
  tailnet = instance
  tailnetDeps = deps
}

export function onTailnetChange(state: GatewayTailnetState): void {
  setTailnetHosts(
    state.state === 'running' ? [state.ip, state.dnsName].filter((h): h is string => !!h) : [],
  )
  refreshAnnouncement()
}

function toPhoneSafeDevice(d: Device): GatewayDevice {
  return {
    deviceId: d.deviceId,
    name: d.name,
    pubkey: d.pubkey,
    caps: d.caps,
    createdAt: d.createdAt,
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
    discoverable: loadDiscoverable(),
  }
}

function isBindable(address: string): boolean {
  return listBindAddresses().some((a) => a.address === address)
}

export async function enableRemote(): Promise<GatewayEnableResponse> {
  const route = loadRoute()
  if (!isBindable(route.bindAddress)) return { error: 'address-unavailable' }
  const started = await startGateway({
    host: route.bindAddress,
    tailnet: route.tailnet,
    phoneAddress: route.tailnet ? null : route.phoneAddress,
  })
  if (route.tailnet && started.helperPort) {
    tailnet?.start({ helperPort: started.helperPort, port: started.port })
  }
  return remoteStatus()
}

export function setRoute(value: unknown): GatewaySetRouteResult {
  if (gatewayStatus().running) return { ok: false, error: 'running' }
  const route = checkRoute(value)
  if (route === 'invalid-phone-address') return { ok: false, error: route }
  if (route === 'unknown-address' || !isBindable(route.bindAddress)) {
    return { ok: false, error: 'unknown-address' }
  }
  saveRoute(route)
  return { ok: true, route }
}

function pairTarget(): GatewayPhoneAddress | null {
  const status = gatewayStatus()
  if (!status.running || !status.port) return null
  const route = loadRoute()
  if (route.tailnet) {
    const node = tailnetState()
    return node.state === 'running' && node.ip ? { host: node.ip, port: status.port } : null
  }
  if (route.phoneAddress) return route.phoneAddress
  if (route.bindAddress === LOOPBACK_ADDRESS || status.host !== route.bindAddress) return null
  return { host: route.bindAddress, port: status.port }
}

export async function disableRemote(): Promise<GatewayRemoteStatus> {
  await tailnet?.stop()
  await stopGateway()
  refreshAnnouncement()
  return remoteStatus()
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

export function gatewayDevicesList(): { devices: GatewayDevice[] } {
  return { devices: listDevices().map(toPhoneSafeDevice) }
}

export function gatewayRevoke(params: unknown): { ok: boolean; error?: string } {
  const { deviceId } = (params ?? {}) as { deviceId?: unknown }
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, error: 'missing-device-id' }
  }
  if (!revokeDevice(deviceId)) return { ok: false, error: 'not-found' }
  closeDeviceSockets(deviceId)
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
  if (result.ok) applyDeviceCaps(deviceId, result.caps)
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
  return answerPairRequest(requestId, approve) ? { ok: true } : { ok: false, error: 'invalid' }
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
