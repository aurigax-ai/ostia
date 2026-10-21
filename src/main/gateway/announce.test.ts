import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRIENDLY_NAME } from '../../shared/gateway/friendlyName'
import type { GatewayTailnetState } from '../../shared/gateway/gatewayApi'
import { storePath } from '../platform/jsonStore'
import type { Tailnet } from './tailnet'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const registeredMethods = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string) => registeredMethods.push(name),
}))

const LAN_ADDRESS = '192.168.2.108'
vi.mock('./interfaces', () => ({
  listBindAddresses: () => [
    { address: '127.0.0.1', iface: 'lo', loopback: true },
    { address: LAN_ADDRESS, iface: 'wlan0', loopback: false },
  ],
}))

const server = vi.hoisted(() => ({ running: false, host: '127.0.0.1' }))
vi.mock('./server', () => ({
  startGateway: vi.fn(async (options?: { host?: string; tailnet?: boolean }) => {
    server.running = true
    server.host = options?.host ?? '127.0.0.1'
    const helperPort = options?.tailnet === false ? null : 40001
    return { host: server.host, port: 8722, helperPort, fingerprint: 'sha256/fp' }
  }),
  stopGateway: vi.fn(async () => {
    server.running = false
  }),
  gatewayStatus: () => ({
    running: server.running,
    host: server.running ? server.host : null,
    port: server.running ? 8722 : null,
    fingerprint: server.running ? 'sha256/fp' : null,
    deviceCount: 0,
  }),
  gatewayHelperPort: () => (server.running ? 40001 : null),
  setTailnetNode: vi.fn(),
  applyDeviceCaps: vi.fn(),
  closeDeviceSockets: vi.fn(),
  currentPhonePush: () => null,
}))

const {
  configureAnnouncer,
  configureTailnet,
  disableRemote,
  enableRemote,
  gatewayPair,
  registerGatewayIpc,
} = await import('./gatewayIpc')
const { consumeCode, resetCodes } = await import('./pairing')
const { friendlyName, saveRoute } = await import('./route')

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-gateway-route-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

let tailnetState: GatewayTailnetState = { state: 'off' }
const tailnet: Tailnet = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  state: () => tailnetState,
}
const openExternal = vi.fn()

function invoke(channel: string, senderType = 'window', params?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: { getType: () => senderType } }, params))
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  server.running = false
  tailnetState = { state: 'off' }
  rmSync(storePath('gateway-config', 'global'), { force: true })
  configureTailnet(tailnet, { openExternal })
  registerGatewayIpc()
})

const publisher = { publish: vi.fn(), unpublish: vi.fn(), unpublishAll: vi.fn() }

function withdrawals(key: string): number {
  return publisher.unpublish.mock.calls.filter(([k]) => k === key).length
}

function lastPublished(key: string): Record<string, unknown> | undefined {
  return publisher.publish.mock.calls.filter(([k]) => k === key).at(-1)?.[1]
}

beforeEach(() => {
  resetCodes()
  configureAnnouncer(publisher)
})

afterEach(() => {
  vi.useRealTimers()
})

async function liveTailnet(): Promise<void> {
  await enableRemote()
  tailnetState = { state: 'running', ip: '100.64.1.2', dnsName: 'ostia-box.example.ts.net' }
}

function mintCode(): string {
  const qr = gatewayPair()
  if ('error' in qr) throw new Error(qr.error)
  return qr.pairCode
}

describe('the desktop announces itself only while pairing and discoverable', () => {
  it('CPD-C1 announces name, host, port and fingerprint on either route while a code is shown', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()
    mintCode()
    expect(publisher.publish).toHaveBeenLastCalledWith('pairing', {
      name: friendlyName(),
      type: 'ostia',
      protocol: 'tcp',
      port: 8722,
      host: `${friendlyName()}.local`,
      txt: { v: '1', name: friendlyName(), host: '100.64.1.2', port: '8722', fp: 'sha256/fp' },
    })

    await disableRemote()
    saveRoute({
      bindAddress: LAN_ADDRESS,
      bindInterface: 'wlan0',
      tailnet: false,
      phoneAddress: null,
      relay: false,
    })
    await enableRemote()
    mintCode()
    expect(lastPublished('pairing')).toMatchObject({ txt: { host: LAN_ADDRESS } })
  })

  it('CPD-C2 announces nothing while Discoverable is off', async () => {
    await liveTailnet()
    mintCode()
    expect(lastPublished('pairing')).toBeUndefined()
  })

  it('CPD-C3 withdraws the announcement when the code is used, expires or remote access stops', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()

    consumeCode(mintCode())
    expect(withdrawals('pairing')).toBe(1)

    vi.useFakeTimers()
    mintCode()
    vi.advanceTimersByTime(120_001)
    expect(withdrawals('pairing')).toBe(2)
    vi.useRealTimers()

    mintCode()
    await disableRemote()
    expect(withdrawals('pairing')).toBe(3)
  })

  it('CPD-C6 never puts a code, token or device in the announcement', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()
    const code = mintCode()
    const { txt } = lastPublished('pairing') as { txt: Record<string, string> }
    expect(Object.keys(txt).sort()).toEqual(['fp', 'host', 'name', 'port', 'v'])
    expect(Object.values(txt)).not.toContain(code)
  })
})

describe('the desktop announces itself for paired phones on a local bind', () => {
  const LAN_ROUTE = {
    bindAddress: LAN_ADDRESS,
    bindInterface: 'wlan0',
    tailnet: false,
    phoneAddress: null,
    relay: false,
  }

  it('RDS-C1 announces the friendly name with only the version and the port, no code needed', async () => {
    saveRoute(LAN_ROUTE)
    await enableRemote()
    const lan = lastPublished('lan') as { name: string; host: string; iface: string }
    expect(lan).toMatchObject({
      type: 'ostia',
      protocol: 'tcp',
      port: 8722,
      iface: LAN_ADDRESS,
      txt: { v: '1', mode: 'paired', port: '8722' },
    })
    expect(lan.name).toMatch(FRIENDLY_NAME)
    expect(lan.host).toBe(`${lan.name}.local`)
  })

  it('RDS-C2 puts no hostname in any announce, and no fingerprint, code or token in the paired-phone one', async () => {
    saveRoute(LAN_ROUTE)
    await invoke('gateway:set-discoverable', 'window', true)
    await enableRemote()
    const code = mintCode()
    const lan = lastPublished('lan') as { name: string; host: string; txt: Record<string, string> }
    expect(Object.keys(lan.txt).sort()).toEqual(['mode', 'port', 'v'])
    const pairing = lastPublished('pairing')
    expect(JSON.stringify(pairing)).not.toContain(hostname())
    expect(JSON.stringify(lan)).not.toContain(hostname())
    for (const secret of ['sha256/fp', code]) {
      expect(JSON.stringify(lan)).not.toContain(secret)
    }
  })

  it('RDS-C3 announces nothing with a loopback bind', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()
    mintCode()
    expect(lastPublished('lan')).toBeUndefined()
  })

  it('RDS-C4 withdraws the announcement when remote access stops', async () => {
    saveRoute(LAN_ROUTE)
    await enableRemote()
    await disableRemote()
    expect(withdrawals('lan')).toBe(1)
  })

  it('RDS-C5 keeps the same random name across restarts', async () => {
    saveRoute(LAN_ROUTE)
    await enableRemote()
    const first = lastPublished('lan')?.name
    await disableRemote()
    await enableRemote()
    expect(lastPublished('lan')?.name).toBe(first)
  })
})
