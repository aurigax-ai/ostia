import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayTailnetState } from '../../shared/types'
import { loadJson, storePath } from '../jsonStore'
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
  setTailnetHosts: vi.fn(),
  applyDeviceCaps: vi.fn(),
  closeDeviceSockets: vi.fn(),
}))

const { configureTailnet, registerGatewayIpc, registerGatewayMethods, remoteStatus } = await import(
  './index'
)
const { listPairRequests, openPairRequest, resetPairRequests, revealPairRequest } = await import(
  './pairRequests'
)

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

function pendingRequest(): { requestId: string; reply: ReturnType<typeof vi.fn> } {
  const nonce = randomBytes(32)
  const { requestId } = openPairRequest({
    name: 'Pixel 9',
    pubkey: 'pk',
    commit: createHash('sha256').update(nonce).digest('hex'),
    peer: '100.64.0.2',
  })
  const reply = vi.fn()
  revealPairRequest(requestId, nonce.toString('base64'), 'sha256/fp', reply)
  return { requestId, reply }
}

describe("Discoverable and pairing approval are the human's", () => {
  it('CPD-C4 starts with Discoverable off and keeps it on once turned on', async () => {
    expect(remoteStatus().discoverable).toBe(false)
    expect(await invoke('gateway:set-discoverable', 'window', true)).toEqual({ ok: true })
    expect(
      loadJson<{ discoverable?: unknown }>(storePath('gateway-config', 'global'), {}),
    ).toMatchObject({
      discoverable: true,
    })
    expect(remoteStatus().discoverable).toBe(true)
  })

  it('CPD-C5 refuses Discoverable from a webview guest and offers no socket method for it', async () => {
    expect(await invoke('gateway:set-discoverable', 'webview', true)).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(await invoke('gateway:set-discoverable', 'window', 'yes')).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(remoteStatus().discoverable).toBe(false)
    registeredMethods.length = 0
    registerGatewayMethods()
    expect(registeredMethods.filter((m) => /discover/i.test(m))).toEqual([])
  })

  it('CPD-C15 answers a pairing request only from a top-level window', async () => {
    resetPairRequests()
    const { requestId, reply } = pendingRequest()
    expect(await invoke('gateway:pair-answer', 'webview', { requestId, approve: true })).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(listPairRequests()).toHaveLength(1)
    expect(reply).not.toHaveBeenCalled()

    registeredMethods.length = 0
    registerGatewayMethods()
    expect(registeredMethods.filter((m) => /pair\.|approve|answer/i.test(m))).toEqual([])

    expect(await invoke('gateway:pair-answer', 'window', { requestId, approve: false })).toEqual({
      ok: true,
    })
    expect(reply).toHaveBeenCalledWith(403, { error: 'declined' })
    expect(listPairRequests()).toEqual([])
  })
})
