import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/types'
import { saveJson, storePath } from '../platform/jsonStore'
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

const DEFAULT_ROUTE = { bindAddress: '127.0.0.1', tailnet: true, phoneAddress: null }
const LAN_ROUTE = { bindAddress: LAN_ADDRESS, tailnet: false, phoneAddress: null }

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
  setTailnetHosts: vi.fn(),
  applyDeviceCaps: vi.fn(),
  closeDeviceSockets: vi.fn(),
}))

const { configureTailnet, registerGatewayIpc, registerGatewayMethods } = await import('./index')
const { startGateway } = await import('./server')

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

describe('gateway IPC and socket surface for the tailnet', () => {
  it('TSN-C22 offers no control-socket method that starts or signs in the tailnet node', () => {
    registeredMethods.length = 0
    registerGatewayMethods()
    expect([...registeredMethods].sort()).toEqual([
      'gateway.devices',
      'gateway.pair',
      'gateway.revoke',
      'gateway.status',
    ])
  })

  it('TSN-C23 refuses tailnet sign-in and sign-out from a webview guest', async () => {
    tailnetState = { state: 'needs-login', authUrl: 'https://login.tailscale.com/a/abc' }
    expect(await invoke('gateway:tailnet-sign-in', 'webview')).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(await invoke('gateway:tailnet-sign-out', 'webview')).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(tailnet.signOut).not.toHaveBeenCalled()
  })

  it('TSN-C24 opens a Tailscale login link in the browser', async () => {
    tailnetState = { state: 'needs-login', authUrl: 'https://login.tailscale.com/a/abc' }
    expect(await invoke('gateway:tailnet-sign-in')).toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith('https://login.tailscale.com/a/abc')
  })

  it('TSN-C25 refuses a login link that is not https on the Tailscale login host', async () => {
    for (const authUrl of ['http://login.tailscale.com/a/abc', 'https://evil.example/a/abc']) {
      tailnetState = { state: 'needs-login', authUrl }
      expect(await invoke('gateway:tailnet-sign-in')).toEqual({
        ok: false,
        error: 'login-link-refused',
      })
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('TSN-C26 reopens the current login link when asked again', async () => {
    tailnetState = { state: 'needs-login', authUrl: 'https://login.tailscale.com/a/abc' }
    await invoke('gateway:tailnet-sign-in')
    await invoke('gateway:tailnet-sign-in')
    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(openExternal).toHaveBeenLastCalledWith('https://login.tailscale.com/a/abc')
  })

  it('TSN-C30 puts the tailnet IPv4 in the pairing payload', async () => {
    await invoke('gateway:enable')
    expect(tailnet.start).toHaveBeenCalledWith({ helperPort: 40001, port: 8722 })
    tailnetState = { state: 'running', ip: '100.114.10.128', dnsName: 'ostia-x.example.ts.net' }
    expect(await invoke('gateway:pair')).toMatchObject({
      v: 1,
      host: '100.114.10.128',
      port: 8722,
      fingerprint: 'sha256/fp',
    })
  })

  it('TSN-C31 offers no pairing while the helper has no tailnet IPv4', async () => {
    await invoke('gateway:enable')
    tailnetState = { state: 'running', ip: null, dnsName: null }
    expect(await invoke('gateway:pair')).toEqual({ error: 'not-running' })
    tailnetState = { state: 'needs-login', authUrl: 'https://login.tailscale.com/a/abc' }
    expect(await invoke('gateway:pair')).toEqual({ error: 'not-running' })
  })

  it('TSN-C40 refuses a route change from a webview guest', async () => {
    expect(await invoke('gateway:set-route', 'webview', LAN_ROUTE)).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(await invoke('gateway:status')).toMatchObject({ route: DEFAULT_ROUTE })
  })

  it('TSN-C44 refuses 0.0.0.0, a hostname or an address this computer does not have', async () => {
    for (const bindAddress of ['0.0.0.0', 'localhost', 'desk.example', '10.9.9.9', '0.0.0.0; rm']) {
      expect(await invoke('gateway:set-route', 'window', { ...LAN_ROUTE, bindAddress })).toEqual({
        ok: false,
        error: 'unknown-address',
      })
    }
    for (const route of [{ kind: 'tailnet' }, { ...LAN_ROUTE, tailnet: 'yes' }, null]) {
      expect(await invoke('gateway:set-route', 'window', route)).toEqual({
        ok: false,
        error: 'unknown-address',
      })
    }
    expect(await invoke('gateway:status')).toMatchObject({ route: DEFAULT_ROUTE })
  })

  it('TSN-C43 accepts 127.0.0.1 as the bind address', async () => {
    const route = { ...LAN_ROUTE, bindAddress: '127.0.0.1' }
    expect(await invoke('gateway:set-route', 'window', route)).toEqual({ ok: true, route })
    expect(await invoke('gateway:status')).toMatchObject({ route })
  })

  it('TSN-C47 refuses a phone address with a scheme, a path, no port or a bad port', async () => {
    for (const phoneAddress of [
      { host: 'https://desk.example', port: 443 },
      { host: 'desk.example/path', port: 443 },
      { host: 'desk.example' },
      { host: 'desk.example', port: 0 },
      { host: 'desk.example', port: 70000 },
      { host: '999.1.1.1', port: 8722 },
      'desk.example:443',
    ]) {
      expect(await invoke('gateway:set-route', 'window', { ...LAN_ROUTE, phoneAddress })).toEqual({
        ok: false,
        error: 'invalid-phone-address',
      })
    }
  })

  it('TSN-C38 refuses a route change while remote access is on', async () => {
    await invoke('gateway:enable')
    expect(await invoke('gateway:set-route', 'window', LAN_ROUTE)).toEqual({
      ok: false,
      error: 'running',
    })
  })

  it('TSN-C45 with the node off listens only on the bind address, starts no tsnet and pairs with it', async () => {
    expect(await invoke('gateway:set-route', 'window', LAN_ROUTE)).toEqual({
      ok: true,
      route: LAN_ROUTE,
    })
    expect(await invoke('gateway:enable')).toMatchObject({
      running: true,
      host: LAN_ADDRESS,
      route: LAN_ROUTE,
    })
    expect(startGateway).toHaveBeenCalledWith({
      host: LAN_ADDRESS,
      tailnet: false,
      phoneAddress: null,
    })
    expect(tailnet.start).not.toHaveBeenCalled()
    expect(await invoke('gateway:pair')).toMatchObject({ host: LAN_ADDRESS, port: 8722 })
  })

  it('TSN-C46 with the node off puts the phone address in the pairing payload', async () => {
    const phoneAddress = { host: 'desk.example.ts.net', port: 443 }
    const route = { bindAddress: '127.0.0.1', tailnet: false, phoneAddress }
    expect(await invoke('gateway:set-route', 'window', route)).toEqual({ ok: true, route })
    await invoke('gateway:enable')
    expect(startGateway).toHaveBeenCalledWith({
      host: '127.0.0.1',
      tailnet: false,
      phoneAddress,
    })
    expect(tailnet.start).not.toHaveBeenCalled()
    expect(await invoke('gateway:pair')).toMatchObject({ host: 'desk.example.ts.net', port: 443 })
  })

  it('TSN-C50 offers no pairing on 127.0.0.1 with the node off and no phone address', async () => {
    await invoke('gateway:set-route', 'window', { ...LAN_ROUTE, bindAddress: '127.0.0.1' })
    expect(await invoke('gateway:enable')).toMatchObject({ running: true, host: '127.0.0.1' })
    expect(await invoke('gateway:pair')).toEqual({ error: 'not-running' })
  })

  it('TSN-C46 ignores the phone address while the node is on', async () => {
    const route = {
      bindAddress: '127.0.0.1',
      tailnet: true,
      phoneAddress: { host: 'desk.example.ts.net', port: 443 },
    }
    await invoke('gateway:set-route', 'window', route)
    await invoke('gateway:enable')
    expect(startGateway).toHaveBeenCalledWith({
      host: '127.0.0.1',
      tailnet: true,
      phoneAddress: null,
    })
    tailnetState = { state: 'running', ip: '100.64.0.9', dnsName: 'ostia-x.example.ts.net' }
    expect(await invoke('gateway:pair')).toMatchObject({ host: '100.64.0.9', port: 8722 })
  })

  it('TSN-C45 turning the node back on starts the helper on the next enable', async () => {
    await invoke('gateway:set-route', 'window', LAN_ROUTE)
    await invoke('gateway:set-route', 'window', { ...LAN_ROUTE, tailnet: true })
    await invoke('gateway:enable')
    expect(startGateway).toHaveBeenCalledWith({
      host: LAN_ADDRESS,
      tailnet: true,
      phoneAddress: null,
    })
    expect(tailnet.start).toHaveBeenCalledWith({ helperPort: 40001, port: 8722 })
  })

  it('TSN-C41 starts nothing when the saved address is no longer on this computer', async () => {
    saveJson(storePath('gateway-config', 'global'), {
      route: { bindAddress: '10.1.2.3', tailnet: true, phoneAddress: null },
    })
    expect(await invoke('gateway:enable')).toEqual({ error: 'address-unavailable' })
    expect(startGateway).not.toHaveBeenCalled()
    expect(tailnet.start).not.toHaveBeenCalled()
  })
})
