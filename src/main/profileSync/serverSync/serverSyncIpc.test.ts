import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSyncResult } from '../../../shared/profileSync/serverSync'

type Handler = (e: unknown, ...args: unknown[]) => Promise<ServerSyncResult>

const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}))

import { registerServerSyncIpc } from './serverSyncIpc'

const STATUS = {
  state: 'ready' as const,
  host: 'h',
  linking: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
}
const OK: ServerSyncResult = { ok: true, status: STATUS }
const window = { sender: { getType: () => 'window' } }
const webview = { sender: { getType: () => 'webview' } }

const service = {
  status: vi.fn(async () => STATUS),
  setup: vi.fn(async () => OK),
  unlock: vi.fn(async () => OK),
  recover: vi.fn(async () => OK),
  linkStart: vi.fn(async () => OK),
  linkStop: vi.fn(async () => OK),
  approveJoin: vi.fn(async () => OK),
  removeDevice: vi.fn(async () => OK),
  rotate: vi.fn(async () => OK),
  newRecoveryKey: vi.fn(async () => OK),
  collectGarbage: vi.fn(async () => OK),
}
const run = vi.fn(async () => undefined)
const broadcast = vi.fn()

const call = (channel: string, e: unknown, ...args: unknown[]) =>
  (handlers.get(channel) as Handler)(e, ...args)

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerServerSyncIpc({
    service: service as unknown as Parameters<typeof registerServerSyncIpc>[0]['service'],
    run,
    broadcast,
  })
})

describe('syncServer owner IPC', () => {
  it('SSY-C110 refuses every channel from anything but a top-level window', async () => {
    for (const channel of handlers.keys()) {
      const res = await call(channel, webview, 'x', 'y', 'z')
      expect(res).toMatchObject(
        channel === 'syncServer:status' ? { state: 'signed-out' } : { ok: false },
      )
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('SSY-C111 bounds and types every input before acting', async () => {
    const long = 'x'.repeat(1025)
    expect(await call('syncServer:setup', window, 'a', 5)).toMatchObject({ error: 'invalid-input' })
    expect(await call('syncServer:setup', window, long, long)).toMatchObject({
      error: 'invalid-input',
    })
    expect(await call('syncServer:unlock', window)).toMatchObject({ error: 'invalid-input' })
    expect(await call('syncServer:approve-join', window, 'x'.repeat(129))).toMatchObject({
      error: 'invalid-input',
    })
    expect(await call('syncServer:approve-join', window, '')).toMatchObject({
      error: 'invalid-input',
    })
    expect(service.setup).not.toHaveBeenCalled()
    expect(service.unlock).not.toHaveBeenCalled()
    expect(service.approveJoin).not.toHaveBeenCalled()
  })

  it('SSY-C112 syncs after a key change, announces the status and returns no secret', async () => {
    const res = await call('syncServer:unlock', window, 'a long passphrase')
    expect(service.unlock).toHaveBeenCalledWith('a long passphrase')
    expect(run).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('syncServer:status', STATUS)
    expect(JSON.stringify(res)).not.toContain('a long passphrase')
    await call('syncServer:gc', window)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('SSY-C113 passes the removal inputs through in order', async () => {
    await call('syncServer:remove-device', window, 'd2', 'pass phrase 1', 'AAAA-BBBB')
    expect(service.removeDevice).toHaveBeenCalledWith('d2', 'pass phrase 1', 'AAAA-BBBB')
  })
})
