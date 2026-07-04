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
 */
import { hostname } from 'node:os'
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
function toPhoneSafeDevice(d: Device): Omit<Device, 'token'> {
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

export function registerGatewayMethods(): void {
  registerControlMethod('gateway.enable', {
    cap: 'gateway',
    handler: (params) => startGateway(parseStartOptions(params)),
  })

  registerControlMethod('gateway.disable', {
    cap: 'gateway',
    handler: async () => {
      await stopGateway()
      return { ok: true }
    },
  })

  // Mirrors the contract's "Connect a device / Pair phone" menu action (§3 step 1): pairing IS
  // the thing that turns the gateway on if it isn't already running, on top of minting the code.
  registerControlMethod('gateway.pair', {
    cap: 'gateway',
    handler: async () => {
      let status = gatewayStatus()
      if (!status.running) {
        const started = await startGateway()
        status = { ...status, ...started, running: true }
      }
      return {
        v: 1,
        host: status.host,
        port: status.port,
        fingerprint: status.fingerprint,
        pairCode: newCode(),
        name: hostname(),
        warning: hostWarning(status.host),
      }
    },
  })

  registerControlMethod('gateway.status', {
    cap: 'gateway',
    handler: () => gatewayStatus(),
  })

  registerControlMethod('gateway.devices', {
    cap: 'gateway',
    handler: () => ({ devices: listDevices().map(toPhoneSafeDevice) }),
  })

  registerControlMethod('gateway.revoke', {
    cap: 'gateway',
    handler: (params) => {
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
    },
  })
}
