import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerSyncResult } from '../../../shared/profileSync/serverSync'

type Handler = (e: unknown, ...args: unknown[]) => Promise<ServerSyncResult>

const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
}))

import { registerServerSyncIpc } from './serverSyncIpc'

const STATUS = { state: 'ready' as const, host: 'h' }
const OK: ServerSyncResult = { ok: true, status: STATUS }
const window = { sender: { getType: () => 'window' } }
const webview = { sender: { getType: () => 'webview' } }

const service = {
  status: vi.fn(async () => STATUS),
  setup: vi.fn(async () => OK),
  unlock: vi.fn(async () => OK),
  recover: vi.fn(async () => OK),
  changePassphrase: vi.fn(async () => OK),
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
    expect(await call('syncServer:recover', window, 'AAAA', 'pw')).toMatchObject({
      error: 'invalid-input',
    })
    expect(service.setup).not.toHaveBeenCalled()
    expect(service.unlock).not.toHaveBeenCalled()
    expect(service.recover).not.toHaveBeenCalled()
  })

  it('SSY-C112 syncs after a key change, announces the status and returns no secret', async () => {
    const res = await call('syncServer:unlock', window, 'a long passphrase')
    expect(service.unlock).toHaveBeenCalledWith('a long passphrase')
    expect(run).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('syncServer:status', STATUS)
    expect(JSON.stringify(res)).not.toContain('a long passphrase')
  })

  it('SSY-C113 passes the passphrase change and the recovery inputs through in order', async () => {
    await call('syncServer:change-passphrase', window, 'old phrase', 'new phrase', 'new phrase')
    expect(service.changePassphrase).toHaveBeenCalledWith('old phrase', 'new phrase', 'new phrase')
    await call('syncServer:recover', window, 'AAAA-BBBB', 'new phrase', 'new phrase')
    expect(service.recover).toHaveBeenCalledWith('AAAA-BBBB', 'new phrase', 'new phrase')
  })
})
