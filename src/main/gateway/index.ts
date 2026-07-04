/**
 * `gateway` toolbelt service — control methods that manage the LAN control gateway itself
 * (Phase C batch 1, `pine-companion/NETWORK-CONTRACT.md`). Gated on the NEW elevated `gateway`
 * capability (`shared/capabilities.ts`): enabling remote access to the desktop, minting pairing
 * codes, and revoking devices are all system-facing, cross-boundary actions — the same posture
 * as `browse`/`settings-write`, not a pane-scoped default.
 *
 * These are internal control-socket methods (the `pine` CLI / a trusted pane calls them to
 * operate the gateway) — distinct from the gateway's OWN phone-facing WS protocol
 * (`server.ts`'s `hello`/`whoami`), which the contract defines separately.
 *
 * The renderer also needs direct access (Settings' "Remote / Companion" section — a human
 * toggling remote access / pairing a phone from a menu, not just the CLI): `registerGatewayIpc`
 * below wires `gateway:enable`/`disable`/`pair`/`status`/`devices`/`revoke` ipc handlers that
 * call the exact same `gatewayEnable`/`gatewayDisable`/`gatewayPair`/`gatewayDevicesList`/
 * `gatewayRevoke` functions the control methods use — one implementation per action, matching
 * `kanban.ts`/`wiki.ts`'s socket-method ⇄ ipc-handler convention. Unlike the socket methods
 * (gated on the elevated `gateway` cap for CLI/agent callers), the ipc handlers are reached only
 * from this app's own trusted renderer — same trust boundary as `kanban:get`/`wiki:list`.
 */
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

/** `gateway.devices` never returns bearer tokens — same "keys/metadata only" posture as `vault.list`. */
function toPhoneSafeDevice(d: Device): GatewayDevice {
  return {
    deviceId: d.deviceId,
    name: d.name,
    pubkey: d.pubkey,
    caps: d.caps,
    createdAt: d.createdAt,
  }
}

/** `{host?, port?}` params, loosely validated (bad input just falls back to the server's defaults). */
function parseStartOptions(params: unknown): GatewayStartOptions {
  const p = (params ?? {}) as { host?: unknown; port?: unknown }
  const host = typeof p.host === 'string' && p.host.trim() ? p.host : undefined
  const port =
    typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port <= 65535
      ? p.port
      : undefined
  return { host, port }
}

/** Start the gateway (idempotent restart) — shared by `gateway.enable` and `gateway:enable`. */
export function gatewayEnable(params: unknown): Promise<GatewayEnableResult> {
  return startGateway(parseStartOptions(params))
}

/** Stop the gateway — shared by `gateway.disable` and `gateway:disable`. */
export async function gatewayDisable(): Promise<{ ok: true }> {
  await stopGateway()
  return { ok: true }
}

/**
 * Mint a pairing code — shared by `gateway.pair` and `gateway:pair`. Mirrors the contract's
 * "Connect a device / Pair phone" menu action (§3 step 1): pairing IS the thing that turns the
 * gateway on if it isn't already running, on top of minting the code.
 */
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

/** Paired devices, phone-safe — shared by `gateway.devices` and `gateway:devices`. */
export function gatewayDevicesList(): { devices: GatewayDevice[] } {
  return { devices: listDevices().map(toPhoneSafeDevice) }
}

/** Revoke a paired device — shared by `gateway.revoke` and `gateway:revoke`. */
export function gatewayRevoke(params: unknown): { ok: boolean; error?: string } {
  const { deviceId } = (params ?? {}) as { deviceId?: unknown }
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, error: 'missing-device-id' }
  }
  if (!revokeDevice(deviceId)) return { ok: false, error: 'not-found' }
  // Security review: "revocation must kill live sessions" — force-close every socket
  // already authed as this device instead of leaving it to work until its next request
  // happens to hit the gateway's own live re-check (`server.ts`'s `isDeviceRevoked`).
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

/** `gateway:enable`/`gateway:disable`/`gateway:pair`/`gateway:status`/`gateway:devices`/
 *  `gateway:revoke` — the renderer's own bridge for Settings' "Remote / Companion" section,
 *  sharing every action's core logic with the control methods above via the exported
 *  `gateway*` functions (see this module's header comment). */
export function registerGatewayIpc(): void {
  ipcMain.handle('gateway:enable', (_e, params) => gatewayEnable(params))
  ipcMain.handle('gateway:disable', () => gatewayDisable())
  ipcMain.handle('gateway:pair', () => gatewayPair())
  ipcMain.handle('gateway:status', () => gatewayStatus())
  ipcMain.handle('gateway:devices', () => gatewayDevicesList())
  ipcMain.handle('gateway:revoke', (_e, params) => gatewayRevoke(params))
}
