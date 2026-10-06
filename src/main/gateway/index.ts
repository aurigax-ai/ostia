import { hostname } from 'node:os'
import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import type {
  GatewayDevice,
  GatewayPairResponse,
  GatewayRemoteStatus,
  GatewaySetCapResult,
  GatewayTailnetActionResult,
  GatewayTailnetState,
} from '../../shared/types'
import { registerControlMethod } from '../controlServer'
import type { Device } from './devices'
import { list as listDevices, revoke as revokeDevice, setDeviceCap } from './devices'
import { newCode } from './pairing'
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
  controlUrl?: string
}

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
  return { ...gatewayStatus(), tailnet: tailnetState() }
}

export async function enableRemote(): Promise<GatewayRemoteStatus> {
  const started = await startGateway()
  tailnet?.start({ helperPort: started.helperPort, port: started.port })
  return remoteStatus()
}

export async function disableRemote(): Promise<GatewayRemoteStatus> {
  await tailnet?.stop()
  await stopGateway()
  return remoteStatus()
}

export function gatewayPair(): GatewayPairResponse {
  const status = gatewayStatus()
  const node = tailnetState()
  if (!status.running || !status.port || !status.fingerprint) return { error: 'not-running' }
  if (node.state !== 'running' || !node.ip) return { error: 'not-running' }
  return {
    v: 1,
    host: node.ip,
    port: status.port,
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

function tailnetSignIn(): GatewayTailnetActionResult {
  const node = tailnetState()
  if (node.state !== 'needs-login') return { ok: false, error: 'no-login-link' }
  if (!isAllowedLoginUrl(node.authUrl, tailnetDeps.controlUrl)) {
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
  if (helperPort && port) tailnet.start({ helperPort, port })
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
  ipcMain.handle('gateway:tailnet-sign-in', (e): GatewayTailnetActionResult => {
    if (!fromWindow(e)) return { ok: false, error: 'not-a-window' }
    return tailnetSignIn()
  })
  ipcMain.handle('gateway:tailnet-sign-out', (e): Promise<GatewayTailnetActionResult> => {
    if (!fromWindow(e)) return Promise.resolve({ ok: false, error: 'not-a-window' })
    return tailnetSignOut()
  })
}
