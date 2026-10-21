import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayRelayState, GatewayTailnetState } from '../../shared/gateway/gatewayApi'
import { storePath } from '../platform/jsonStore'
import type { RelayClient } from './relayClient'
import type { Tailnet } from './tailnet'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

vi.mock('../control/controlServer', () => ({ registerControlMethod: vi.fn() }))

const LAN_ADDRESS = '192.168.2.108'
vi.mock('./interfaces', () => ({
  listBindAddresses: () => [
    { address: '127.0.0.1', iface: 'lo', loopback: true },
    { address: LAN_ADDRESS, iface: 'wlan0', loopback: false },
  ],
}))

const server = vi.hoisted(() => ({
  running: false,
  host: '127.0.0.1',
  started: [] as Array<Record<string, unknown>>,
}))
vi.mock('./server', () => ({
  startGateway: vi.fn(async (options?: { host?: string; tailnet?: boolean; relay?: boolean }) => {
    server.running = true
    server.host = options?.host ?? '127.0.0.1'
    server.started.push({ ...options })
    const helperPort = options?.tailnet === false && options.relay !== true ? null : 40001
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
}))

const {
  configureAnnouncer,
  configureRelay,
  configureTailnet,
  disableRemote,
  enableRemote,
  gatewayPair,
  registerGatewayIpc,
  remoteStatus,
} = await import('./gatewayIpc')
const { resetCodes } = await import('./pairing')
const { saveRoute } = await import('./route')

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-relay-route-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

const RELAY_HOST = 'lblabc.relay.test'
let relayState: GatewayRelayState = { state: 'off' }
let signedIn = true
let tailnetState: GatewayTailnetState = { state: 'off' }
const relay = {
  start: vi.fn(),
  stop: vi.fn(),
  status: () => relayState,
} as unknown as RelayClient
const tailnet: Tailnet = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  state: () => tailnetState,
}
const publisher = { publish: vi.fn(), unpublish: vi.fn(), unpublishAll: vi.fn() }

function invoke(channel: string, params?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: { getType: () => 'window' } }, params))
}

const LAN_ROUTE = {
  bindAddress: LAN_ADDRESS,
  bindInterface: 'wlan0',
  tailnet: false,
  phoneAddress: null,
  relay: true,
}
const LOOPBACK_ROUTE = { ...LAN_ROUTE, bindAddress: '127.0.0.1', bindInterface: null }

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  server.running = false
  server.started = []
  relayState = { state: 'listening', host: RELAY_HOST }
  signedIn = true
  tailnetState = { state: 'off' }
  rmSync(storePath('gateway-config', 'global'), { force: true })
  resetCodes()
  configureTailnet(tailnet, { openExternal: vi.fn() })
  configureRelay(relay, { signedIn: () => signedIn })
  configureAnnouncer(publisher)
  registerGatewayIpc()
})

function pairTarget(): { host: string; port: number } | string {
  const result = gatewayPair()
  return 'error' in result ? result.error : { host: result.host, port: result.port }
}

describe('the relay route', () => {
  it('RLY-C32 is chosen over the owner IPC while the gateway is off, never while it runs', async () => {
    expect(await invoke('gateway:set-route', LAN_ROUTE)).toEqual({ ok: true, route: LAN_ROUTE })
    expect(remoteStatus().route.relay).toBe(true)
    await enableRemote()
    expect(await invoke('gateway:set-route', { ...LAN_ROUTE, relay: false })).toEqual({
      ok: false,
      error: 'running',
    })
    expect(remoteStatus().route.relay).toBe(true)
  })

  it('RLY-C33 starts the relay client with the gateway when the route is on, and only then', async () => {
    saveRoute({ ...LAN_ROUTE, relay: false })
    await enableRemote()
    expect(relay.start).not.toHaveBeenCalled()
    expect(server.started.at(-1)).toMatchObject({ relay: false })
    await disableRemote()
    saveRoute(LAN_ROUTE)
    await enableRemote()
    expect(server.started.at(-1)).toMatchObject({ relay: true })
    expect(relay.start).toHaveBeenCalledTimes(1)
    await disableRemote()
    expect(relay.stop).toHaveBeenCalled()
  })

  it('RLY-C34 reports the relay state: off, needs a sign-in, or the client state', async () => {
    saveRoute({ ...LAN_ROUTE, relay: false })
    expect(remoteStatus().relay).toEqual({ state: 'off' })
    saveRoute(LAN_ROUTE)
    signedIn = false
    expect(remoteStatus().relay).toEqual({ state: 'needs-sign-in' })
    signedIn = true
    relayState = { state: 'error', code: 'unreachable' }
    expect(remoteStatus().relay).toEqual({ state: 'error', code: 'unreachable' })
  })
})

describe('where a new pairing points', () => {
  it('RLY-C35 prefers the running tailnet over the relay', async () => {
    saveRoute({ ...LOOPBACK_ROUTE, tailnet: true })
    await enableRemote()
    tailnetState = { state: 'running', ip: '100.64.1.2', dnsName: 'box.example.ts.net' }
    expect(pairTarget()).toEqual({ host: '100.64.1.2', port: 8722 })
  })

  it('RLY-C36 prefers the phone address, then the LAN bind, over the relay', async () => {
    saveRoute({ ...LOOPBACK_ROUTE, phoneAddress: { host: 'desk.example.org', port: 443 } })
    await enableRemote()
    expect(pairTarget()).toEqual({ host: 'desk.example.org', port: 443 })
    await disableRemote()
    saveRoute(LAN_ROUTE)
    await enableRemote()
    expect(pairTarget()).toEqual({ host: LAN_ADDRESS, port: 8722 })
  })

  it('RLY-C37 falls back to the relay host on 443 when nothing better exists', async () => {
    saveRoute(LOOPBACK_ROUTE)
    await enableRemote()
    expect(pairTarget()).toEqual({ host: RELAY_HOST, port: 443 })
    saveRoute({ ...LOOPBACK_ROUTE, tailnet: true })
    await disableRemote()
    await enableRemote()
    expect(pairTarget()).toEqual({ host: RELAY_HOST, port: 443 })
  })

  it('RLY-C38 offers no pairing while the relay is not listening', async () => {
    saveRoute(LOOPBACK_ROUTE)
    await enableRemote()
    for (const state of [
      { state: 'connecting' },
      { state: 'needs-sign-in' },
      { state: 'error', code: 'unreachable' },
    ] as const) {
      relayState = state
      expect(pairTarget()).toBe('not-running')
    }
  })

  it('RLY-C39 never announces the relay host on the network', async () => {
    saveRoute(LOOPBACK_ROUTE)
    await invoke('gateway:set-discoverable', true)
    await enableRemote()
    gatewayPair()
    expect(publisher.publish.mock.calls.filter(([key]) => key === 'pairing')).toEqual([])
  })
})
