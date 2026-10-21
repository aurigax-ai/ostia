import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: { sender: { getType: () => string } }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
}))

import type { ShareService } from './shareService'
import { registerSharesIpc } from './sharesIpc'

const window = { sender: { getType: () => 'window' } }
const guest = { sender: { getType: () => 'webview' } }

const service = {
  availability: vi.fn(async () => ({ state: 'off' })),
  list: vi.fn(async () => ({ ok: true, shares: [] })),
  copyLink: vi.fn(() => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerSharesIpc(service as unknown as ShareService)
})

describe('shares IPC', () => {
  it('SHR-C50 answers only a top-level window', async () => {
    expect([...handlers.keys()].sort()).toEqual([
      'shares:copy-link',
      'shares:delete',
      'shares:list',
      'shares:status',
    ])
    expect(await handlers.get('shares:status')?.(guest)).toEqual({ state: 'unavailable' })
    expect(await handlers.get('shares:list')?.(guest)).toEqual({ ok: false, error: 'not-a-window' })
    expect(handlers.get('shares:copy-link')?.(guest, 'id')).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(await handlers.get('shares:delete')?.(guest, 'id')).toEqual({
      ok: false,
      error: 'not-a-window',
    })
    expect(service.availability).not.toHaveBeenCalled()
    expect(service.list).not.toHaveBeenCalled()
    expect(service.copyLink).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it('SHR-C51 passes a share id to the service and refuses anything else', async () => {
    expect(handlers.get('shares:copy-link')?.(window, 'abc')).toEqual({ ok: true })
    expect(await handlers.get('shares:delete')?.(window, 'abc')).toEqual({ ok: true })
    expect(service.copyLink).toHaveBeenCalledWith('abc')
    expect(service.remove).toHaveBeenCalledWith('abc')
    for (const bad of [undefined, 7, '', 'x'.repeat(200)]) {
      expect(handlers.get('shares:copy-link')?.(window, bad)).toEqual({
        ok: false,
        error: 'unknown',
      })
      expect(await handlers.get('shares:delete')?.(window, bad)).toEqual({
        ok: false,
        error: 'unknown',
      })
    }
    expect(service.copyLink).toHaveBeenCalledTimes(1)
    expect(service.remove).toHaveBeenCalledTimes(1)
  })
})
