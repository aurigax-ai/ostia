import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-mailipc-'))
process.env.XDG_DATA_HOME = dataHome

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}))

const { mailMap, registerMailIpc } = await import('./mailIpc')
const { enqueue, failPaneMail, flushBus, resetBus, setPending, takeMail } = await import(
  './busStore'
)
const { registerPane } = await import('../control/idRegistry')

const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mi-worker' })
const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mi-boss' })
const broadcast = vi.fn()

registerMailIpc(broadcast)

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  broadcast.mockClear()
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('mailMap', () => {
  it('keys undelivered mail by the receiving pane, names a pane sender by its pane id, and holds no text', () => {
    const mail = enqueue({ from: boss.externalId, to: worker.externalId, text: 'secret plan' })
    setPending(mail.id, 'working')
    const map = mailMap()
    expect(map).toEqual({
      [worker.paneId]: [
        {
          id: mail.id,
          state: 'queued',
          from: { paneId: boss.paneId },
          ts: mail.ts,
          pending: 'working',
        },
      ],
    })
    expect(JSON.stringify(map)).not.toContain('secret plan')
  })

  it('labels a sender that is not a pane, and drops mail for a pane that is not open', () => {
    enqueue({ from: 'ostia', to: worker.externalId, text: 'x' })
    enqueue({ from: boss.externalId, to: 'no-such-pane', text: 'y' })
    const map = mailMap()
    expect(map[worker.paneId]?.[0]?.from).toEqual({ label: 'ostia' })
    expect(Object.keys(map)).toEqual([worker.paneId])
  })

  it('shows a failed message with its reason', () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    failPaneMail(worker.externalId)
    expect(mailMap()[worker.paneId]).toMatchObject([{ state: 'failed', reason: 'pane-closed' }])
  })
})

describe('registerMailIpc', () => {
  it('pushes the map to every window when mail changes, and is quiet when it does not', async () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    await Promise.resolve()
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toBe('bus:mail')
    expect(Object.keys(broadcast.mock.calls[0][1])).toEqual([worker.paneId])
    takeMail(worker.externalId, 'read', () => true)
    await Promise.resolve()
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast.mock.calls[1][1]).toEqual({})
  })

  it('answers a snapshot, and dismisses the failed mail of a pane the renderer names', async () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    failPaneMail(worker.externalId)
    expect(Object.keys(handlers.get('bus:mail-snapshot')?.() as object)).toEqual([worker.paneId])
    handlers.get('bus:mail-dismiss')?.({}, worker.paneId)
    expect(handlers.get('bus:mail-snapshot')?.()).toEqual({})
    handlers.get('bus:mail-dismiss')?.({}, 42)
    handlers.get('bus:mail-dismiss')?.({}, 'unknown')
  })
})
