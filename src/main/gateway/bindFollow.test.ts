import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayBindAddress } from '../../shared/gateway/gatewayApi'
import { storePath } from '../platform/jsonStore'
import type { Tailnet } from './tailnet'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

vi.mock('../control/controlServer', () => ({ registerControlMethod: () => {} }))

const LOOPBACK: GatewayBindAddress = { address: '127.0.0.1', iface: 'lo', loopback: true }
const machine = vi.hoisted(() => ({ addresses: [] as GatewayBindAddress[] }))
vi.mock('./interfaces', () => ({ listBindAddresses: () => machine.addresses }))

const server = vi.hoisted(() => ({
  running: false,
  host: '127.0.0.1',
  inFlight: 0,
  mostInFlight: 0,
}))
vi.mock('./server', () => ({
  startGateway: vi.fn(async (options?: { host?: string; tailnet?: boolean }) => {
    server.inFlight++
    server.mostInFlight = Math.max(server.mostInFlight, server.inFlight)
    await Promise.resolve()
    await Promise.resolve()
    server.inFlight--
    server.running = true
    server.host = options?.host ?? '127.0.0.1'
    return { host: server.host, port: 8722, helperPort: null, fingerprint: 'sha256/fp' }
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
  gatewayHelperPort: () => null,
  setTailnetNode: vi.fn(),
  applyDeviceCaps: vi.fn(),
  closeDeviceSockets: vi.fn(),
}))

const {
  configureAnnouncer,
  configureTailnet,
  disableRemote,
  enableRemote,
  registerGatewayIpc,
  stopRemote,
} = await import('./gatewayIpc')
const { startGateway, stopGateway } = await import('./server')

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-bind-follow-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

const tailnet: Tailnet = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  state: () => ({ state: 'off' }),
}

function invoke(channel: string, params?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: { getType: () => 'window' } }, params))
}

function card(address: string, iface = 'wlan0'): GatewayBindAddress {
  return { address, iface, loopback: false }
}

async function chooseCard(address: string): Promise<void> {
  await invoke('gateway:set-route', {
    bindAddress: address,
    bindInterface: 'forged0',
    tailnet: false,
    phoneAddress: null,
    relay: false,
  })
}

const POLL_MS = 5000

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  handlers.clear()
  server.running = false
  server.mostInFlight = 0
  machine.addresses = [LOOPBACK, card('192.168.2.108')]
  rmSync(storePath('gateway-config', 'global'), { force: true })
  configureAnnouncer({ publish: vi.fn(), unpublish: vi.fn(), unpublishAll: vi.fn() })
  configureTailnet(tailnet, { openExternal: vi.fn() })
  registerGatewayIpc()
})

afterEach(async () => {
  await disableRemote()
  vi.useRealTimers()
})

describe('a local bind follows its network card', () => {
  it('RDS-C6 saves the card the address belongs to, never one the window names', async () => {
    await chooseCard('192.168.2.108')
    const status = (await invoke('gateway:status')) as { route: { bindInterface: string | null } }
    expect(status.route.bindInterface).toBe('wlan0')
  })

  it('RDS-C7 restarts the listener on the card’s new address', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    machine.addresses = [LOOPBACK, card('10.0.0.7')]
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(stopGateway).toHaveBeenCalled()
    expect(startGateway).toHaveBeenLastCalledWith(expect.objectContaining({ host: '10.0.0.7' }))
    expect(server.host).toBe('10.0.0.7')
  })

  it('RDS-C8 does not restart while the address stays the same', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(startGateway).toHaveBeenCalledTimes(1)
  })

  it('RDS-C9 stops listening when the card is gone and starts again when it returns', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    machine.addresses = [LOOPBACK]
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(server.running).toBe(false)
    machine.addresses = [LOOPBACK, card('192.168.2.109')]
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(server.running).toBe(true)
    expect(server.host).toBe('192.168.2.109')
  })

  it('RDS-C10 never moves to another card', async () => {
    await chooseCard('192.168.2.108')
    machine.addresses = [LOOPBACK, card('10.8.0.2', 'tun0')]
    expect(await enableRemote()).toEqual({ error: 'address-unavailable' })
    expect(startGateway).not.toHaveBeenCalled()
  })

  it('RDS-C11 leaves a loopback bind alone', async () => {
    await enableRemote()
    machine.addresses = [LOOPBACK, card('10.0.0.7')]
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(startGateway).toHaveBeenCalledTimes(1)
    expect(server.host).toBe('127.0.0.1')
  })

  it('RDS-C12 stops following once remote access is turned off', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    await disableRemote()
    machine.addresses = [LOOPBACK, card('10.0.0.7')]
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(startGateway).toHaveBeenCalledTimes(1)
  })

  it('RDS-C38 does not start again after quit stopped remote access', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    await stopRemote()
    await stopGateway()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(startGateway).toHaveBeenCalledTimes(1)
    expect(server.running).toBe(false)
  })

  it('RDS-C39 does not start again when remote access is turned off while a restart is pending', async () => {
    await chooseCard('192.168.2.108')
    await enableRemote()
    machine.addresses = [LOOPBACK, card('10.0.0.7')]
    const tick = vi.advanceTimersByTimeAsync(POLL_MS)
    await disableRemote()
    await tick
    expect(server.running).toBe(false)
  })

  it('RDS-C40 never lets two starts run at once', async () => {
    await chooseCard('192.168.2.108')
    await Promise.all([enableRemote(), enableRemote()])
    machine.addresses = [LOOPBACK, card('10.0.0.7')]
    const tick = vi.advanceTimersByTimeAsync(POLL_MS)
    const toggles = Promise.all([disableRemote(), enableRemote()])
    await Promise.all([tick, toggles])
    expect(server.mostInFlight).toBe(1)
    expect(server.running).toBe(true)
  })
})
