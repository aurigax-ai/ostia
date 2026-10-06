import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/types'
import type { Tailnet } from './tailnet'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const registeredMethods = vi.hoisted(() => [] as string[])

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

vi.mock('../controlServer', () => ({
  registerControlMethod: (name: string) => registeredMethods.push(name),
}))

const server = vi.hoisted(() => ({ running: false }))
vi.mock('./server', () => ({
  startGateway: vi.fn(async () => {
    server.running = true
    return { host: '127.0.0.1', port: 8722, helperPort: 40001, fingerprint: 'sha256/fp' }
  }),
  stopGateway: vi.fn(async () => {
    server.running = false
  }),
  gatewayStatus: () => ({
    running: server.running,
    host: server.running ? '127.0.0.1' : null,
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
})
