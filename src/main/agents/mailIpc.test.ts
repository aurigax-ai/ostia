import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-mailipc-'))
process.env.XDG_DATA_HOME = dataHome

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const fromWindow = (id: number) => ({ sender: { id } })
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}))

const { mailMap, registerMailIpc } = await import('./mailIpc')
const { ackMail, enqueue, failPaneMail, flushBus, leaseMail, resetBus, setPending } = await import(
  './busStore'
)
const { registerPane } = await import('../control/idRegistry')

const worker = registerPane({ windowId: '1', workspaceId: 'ws1', paneId: 'mi-worker' })
const boss = registerPane({ windowId: '1', workspaceId: 'ws1', paneId: 'mi-boss' })
const sendToWindow = vi.fn()
const strangerWorkspace = 'ws-elsewhere'
const stranger = registerPane({
  windowId: '2',
  workspaceId: strangerWorkspace,
  paneId: 'mi-stranger',
})

registerMailIpc({
  windowIds: () => ['1', '2'],
  sendToWindow,
  workspaceWindowId: (workspaceId) => (workspaceId === strangerWorkspace ? '2' : '1'),
})

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  sendToWindow.mockClear()
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
  it('pushes each window only the mail of its own panes when mail changes, and is quiet when it does not', async () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    enqueue({ from: boss.externalId, to: stranger.externalId, text: 'y' })
    await Promise.resolve()
    const pushed = Object.fromEntries(
      sendToWindow.mock.calls.map(([windowId, channel, map]) => [windowId, [channel, map]]),
    )
    expect(pushed['1'][0]).toBe('bus:mail')
    expect(Object.keys(pushed['1'][1])).toEqual([worker.paneId])
    expect(Object.keys(pushed['2'][1])).toEqual([stranger.paneId])
    sendToWindow.mockClear()
    ackMail(worker.externalId, leaseMail(worker.externalId, 'read', () => true)?.lease ?? '')
    await Promise.resolve()
    expect(sendToWindow.mock.calls.find(([windowId]) => windowId === '1')?.[2]).toEqual({})
  })

  it('answers a snapshot of the sender’s own panes only', () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    enqueue({ from: boss.externalId, to: stranger.externalId, text: 'y' })
    const snapshot = handlers.get('bus:mail-snapshot')
    expect(Object.keys(snapshot?.(fromWindow(1)) as object)).toEqual([worker.paneId])
    expect(Object.keys(snapshot?.(fromWindow(2)) as object)).toEqual([stranger.paneId])
  })

  it('dismisses the failed mail of a pane the sender owns, and of no other window’s pane', () => {
    enqueue({ from: boss.externalId, to: worker.externalId, text: 'x' })
    failPaneMail(worker.externalId)
    const dismiss = handlers.get('bus:mail-dismiss')
    dismiss?.(fromWindow(2), worker.paneId)
    expect(Object.keys(handlers.get('bus:mail-snapshot')?.(fromWindow(1)) as object)).toEqual([
      worker.paneId,
    ])
    dismiss?.(fromWindow(1), worker.paneId)
    expect(handlers.get('bus:mail-snapshot')?.(fromWindow(1))).toEqual({})
    dismiss?.(fromWindow(1), 42)
    dismiss?.(fromWindow(1), 'unknown')
  })
})
