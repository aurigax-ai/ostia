import { hostname } from 'node:os'
import { ipcMain } from 'electron'
import type { GatewayDevice, GatewayEnableResult, GatewayPairResult } from '../../shared/types'
import { registerControlMethod } from '../controlServer'
import type { Device } from './devices'
import { list as listDevices, revoke as revokeDevice } from './devices'
import { newCode } from './pairing'
import {
  type GatewayStartOptions,
  closeDeviceSockets,
  gatewayStatus,
  hostWarning,
  startGateway,
  stopGateway,
} from './server'

function toPhoneSafeDevice(d: Device): GatewayDevice {
  return {
    deviceId: d.deviceId,
    name: d.name,
    pubkey: d.pubkey,
    caps: d.caps,
    createdAt: d.createdAt,
  }
}

function parseStartOptions(params: unknown): GatewayStartOptions {
  const p = (params ?? {}) as { host?: unknown; port?: unknown }
  const host = typeof p.host === 'string' && p.host.trim() ? p.host : undefined
  const port =
    typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535
      ? p.port
      : undefined
  return { host, port }
}

export function gatewayEnable(params: unknown): Promise<GatewayEnableResult> {
  return startGateway(parseStartOptions(params))
}

export async function gatewayDisable(): Promise<{ ok: true }> {
  await stopGateway()
  return { ok: true }
}

export async function gatewayPair(): Promise<GatewayPairResult> {
  let status = gatewayStatus()
  if (!status.running) {
    const started = await startGateway()
    status = { ...status, ...started, running: true }
  }
  return {
    v: 1,
    host: status.host ?? '',
    port: status.port ?? 0,
    fingerprint: status.fingerprint ?? '',
    pairCode: newCode(),
    name: hostname(),
    warning: hostWarning(status.host),
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

export function registerGatewayMethods(): void {
  registerControlMethod('gateway.enable', {
    cap: 'gateway',
    handler: (params) => gatewayEnable(params),
  })

  registerControlMethod('gateway.disable', {
    cap: 'gateway',
    handler: () => gatewayDisable(),
  })

  registerControlMethod('gateway.pair', {
    cap: 'gateway',
    handler: () => gatewayPair(),
  })

  registerControlMethod('gateway.status', {
    cap: 'gateway',
    handler: () => gatewayStatus(),
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
  ipcMain.handle('gateway:enable', (_e, params) => gatewayEnable(params))
  ipcMain.handle('gateway:disable', () => gatewayDisable())
  ipcMain.handle('gateway:pair', () => gatewayPair())
  ipcMain.handle('gateway:status', () => gatewayStatus())
  ipcMain.handle('gateway:devices', () => gatewayDevicesList())
  ipcMain.handle('gateway:revoke', (_e, params) => gatewayRevoke(params))
}
