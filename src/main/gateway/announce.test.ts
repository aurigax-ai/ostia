import { mkdtempSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/types'
import { storePath } from '../jsonStore'
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

const LAN_ADDRESS = '192.168.2.108'
vi.mock('./interfaces', () => ({
  listBindAddresses: () => [{ address: LAN_ADDRESS, iface: 'wlan0' }],
}))

const server = vi.hoisted(() => ({ running: false, host: '127.0.0.1' }))
vi.mock('./server', () => ({
  startGateway: vi.fn(async (options?: { host?: string }) => {
    server.running = true
    server.host = options?.host ?? '127.0.0.1'
    return { host: server.host, port: 8722, helperPort: 40001, fingerprint: 'sha256/fp' }
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

const {
  configureAnnouncer,
  configureTailnet,
  disableRemote,
  enableRemote,
  gatewayPair,
  registerGatewayIpc,
} = await import('./index')
const { consumeCode, resetCodes } = await import('./pairing')
const { saveRoute } = await import('./route')

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

const publisher = { publish: vi.fn(), unpublish: vi.fn() }

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
    expect(publisher.publish).toHaveBeenLastCalledWith({
      name: hostname(),
      type: 'ostia',
      protocol: 'tcp',
      port: 8722,
      txt: { v: '1', name: hostname(), host: '100.64.1.2', port: '8722', fp: 'sha256/fp' },
    })

    await disableRemote()
    saveRoute({ kind: 'address', address: LAN_ADDRESS })
    await enableRemote()
    mintCode()
    expect(publisher.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ txt: expect.objectContaining({ host: LAN_ADDRESS }) }),
    )
  })

  it('CPD-C2 announces nothing while Discoverable is off', async () => {
    await liveTailnet()
    mintCode()
    expect(publisher.publish).not.toHaveBeenCalled()
  })

  it('CPD-C3 withdraws the announcement when the code is used, expires or remote access stops', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()

    consumeCode(mintCode())
    expect(publisher.unpublish).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    mintCode()
    vi.advanceTimersByTime(120_001)
    expect(publisher.unpublish).toHaveBeenCalledTimes(2)
    vi.useRealTimers()

    mintCode()
    await disableRemote()
    expect(publisher.unpublish).toHaveBeenCalledTimes(3)
  })

  it('CPD-C6 never puts a code, token or device in the announcement', async () => {
    await invoke('gateway:set-discoverable', 'window', true)
    await liveTailnet()
    const code = mintCode()
    const { txt } = publisher.publish.mock.lastCall?.[0] as { txt: Record<string, string> }
    expect(Object.keys(txt).sort()).toEqual(['fp', 'host', 'name', 'port', 'v'])
    expect(Object.values(txt)).not.toContain(code)
  })
})
