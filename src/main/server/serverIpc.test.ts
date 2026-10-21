import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>

const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}))

import { registerServerIpc } from './serverIpc'

const window = { sender: { getType: () => 'window' } }
const webview = { sender: { getType: () => 'webview' } }

const devices = {
  createInvite: vi.fn(async () => ({ ok: true, code: 'c', expiresAt: 1 })),
}
const elevation = {
  start: vi.fn(),
  poll: vi.fn(async () => ({ state: 'pending' })),
  cancel: vi.fn(async () => undefined),
  approve: vi.fn(async () => ({ ok: true })),
}
const openExternal = vi.fn(() => true)

const call = (channel: string, e: unknown, ...args: unknown[]) =>
  (handlers.get(channel) as Handler)(e, ...args)

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerServerIpc({
    account: {} as never,
    devices: devices as never,
    elevation: elevation as never,
    allowInsecure: false,
    openExternal,
  })
})

describe('server device and approval IPC', () => {
  it('SSY-C120 refuses the device, invite and approval channels from a non-window sender', async () => {
    for (const channel of [
      'server:invite-create',
      'server:elevation-start',
      'server:elevation-poll',
      'server:elevation-cancel',
      'server:approve',
    ]) {
      await call(channel, webview, 'approval')
    }
    expect(devices.createInvite).not.toHaveBeenCalled()
    expect(elevation.start).not.toHaveBeenCalled()
    expect(elevation.approve).not.toHaveBeenCalled()
  })

  it('SSY-C121 rejects an unbounded id and an unknown elevation method', async () => {
    expect(await call('server:approve', window, 'x'.repeat(200))).toMatchObject({ ok: false })
    expect(await call('server:elevation-start', window, 'password')).toMatchObject({ ok: false })
    expect(elevation.approve).not.toHaveBeenCalled()
    expect(elevation.start).not.toHaveBeenCalled()
  })

  it('SSY-C122 opens only an https GitHub page for an elevation sign-in', async () => {
    elevation.start.mockResolvedValueOnce({
      ok: true,
      kind: 'github',
      userCode: 'AB-12',
      verificationUri: 'https://github.com/login/device',
    })
    await call('server:elevation-start', window, 'github')
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device')
    elevation.start.mockResolvedValueOnce({
      ok: true,
      kind: 'github',
      userCode: 'AB-12',
      verificationUri: 'javascript:alert(1)',
    })
    await call('server:elevation-start', window, 'github')
    elevation.start.mockResolvedValueOnce({
      ok: true,
      kind: 'github',
      userCode: 'AB-12',
      verificationUri: 'https://phish.example/login/device',
    })
    await call('server:elevation-start', window, 'github')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
