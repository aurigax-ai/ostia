import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayDevice } from '../../../shared/gateway/gatewayApi'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const pushStub = vi.hoisted(() => ({
  availability: vi.fn(() => 'available'),
  setEnabled: vi.fn(async () => ({ ok: true })),
  deviceRemoved: vi.fn(),
  capsChanged: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

vi.mock('../../control/controlServer', () => ({ registerControlMethod: vi.fn() }))

vi.mock('../interfaces', () => ({
  listBindAddresses: () => [{ address: '127.0.0.1', iface: 'lo', loopback: true }],
}))

vi.mock('../server', () => ({
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  gatewayStatus: () => ({
    running: false,
    host: null,
    port: null,
    fingerprint: null,
    deviceCount: 0,
  }),
  gatewayHelperPort: () => null,
  setTailnetNode: vi.fn(),
  applyDeviceCaps: vi.fn(),
  closeDeviceSockets: vi.fn(),
  currentPhonePush: () => pushStub,
}))

const { registerGatewayIpc, remoteStatus } = await import('../gatewayIpc')
const { closeDeviceSockets } = await import('../server')
const { registerDevice, setDevicePush } = await import('../devices')
const { openPairRequest, revealPairRequest } = await import('../pairRequests')

const HANDLE = 'q'.repeat(26)

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-gateway-push-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

function invoke(channel: string, senderType = 'window', params?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({ sender: { getType: () => senderType } }, params))
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerGatewayIpc()
})

describe('the push switch is the human’s', () => {
  it('PSH-C32 changes the switch only from a top-level window and checks its arguments', async () => {
    expect(
      await invoke('gateway:set-device-push', 'webview', { deviceId: 'dev_1', enabled: true }),
    ).toEqual({ ok: false, error: 'not-a-window' })
    expect(await invoke('gateway:set-device-push', 'window', { deviceId: 5 })).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(pushStub.setEnabled).not.toHaveBeenCalled()
    expect(
      await invoke('gateway:set-device-push', 'window', { deviceId: 'dev_1', enabled: true }),
    ).toEqual({ ok: true })
    expect(pushStub.setEnabled).toHaveBeenCalledWith('dev_1', true)
  })

  it('PSH-C33 shows the device list only whether push is on and registered, never the handle', async () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    expect(setDevicePush(deviceId, { enabled: true, handle: HANDLE, platform: 'fcm' })).toBe(true)
    const listed = (await invoke('gateway:devices')) as { devices: GatewayDevice[] }
    expect(listed.devices.find((d) => d.deviceId === deviceId)?.push).toEqual({
      enabled: true,
      registered: true,
    })
    expect(JSON.stringify(listed)).not.toContain(HANDLE)
  })

  it('PSH-C34 reports whether the server offers push in the remote status', () => {
    expect(remoteStatus().push).toBe('available')
    pushStub.availability.mockReturnValueOnce('server-push-off')
    expect(remoteStatus().push).toBe('server-push-off')
  })

  it('PSH-C35 deletes the handle on the server after it closed the sockets of a revoked device', async () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    setDevicePush(deviceId, { enabled: true, handle: HANDLE, platform: 'fcm' })
    expect(await invoke('gateway:revoke', 'window', { deviceId })).toEqual({ ok: true })
    expect(closeDeviceSockets).toHaveBeenCalledWith(deviceId)
    expect(pushStub.deviceRemoved).toHaveBeenCalledWith(HANDLE)
  })

  it('PSH-C36 deletes the handle of a device an approval replaces', async () => {
    const installId = 'b'.repeat(24)
    const old = registerDevice({ name: 'Pixel', pubkey: 'pk0', installId })
    setDevicePush(old.deviceId, { enabled: true, handle: HANDLE, platform: 'fcm' })
    const nonce = randomBytes(32)
    const { requestId } = openPairRequest({
      name: 'Pixel 9',
      pubkey: 'pk1',
      installId,
      commit: createHash('sha256').update(nonce).digest('hex'),
      peer: '100.64.0.2',
    })
    revealPairRequest(requestId, nonce.toString('base64'), 'sha256/fp', vi.fn())
    expect(await invoke('gateway:pair-answer', 'window', { requestId, approve: true })).toEqual({
      ok: true,
    })
    expect(pushStub.deviceRemoved).toHaveBeenCalledWith(HANDLE)
  })

  it('PSH-C71 lets the push switch react after the human changes a phone permission', async () => {
    const { deviceId } = registerDevice({ name: 'Pixel', pubkey: 'pk' })
    expect(
      await invoke('gateway:set-cap', 'window', { deviceId, cap: 'input', granted: true }),
    ).toMatchObject({ ok: true })
    expect(pushStub.capsChanged).toHaveBeenCalledWith(deviceId)
  })
})
