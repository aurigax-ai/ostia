import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-events-'))
process.env.XDG_DATA_HOME = dataHome

const { PaneEvents } = await import('./paneEvents')
const { PaneJournal } = await import('./paneJournal')
const { ackMail, flushBus, inboxOf, leaseMail, resetBus, watchPane } = await import(
  '../agents/busStore'
)
const { registerPane } = await import('../control/idRegistry')

const readAll = (to: string): void => {
  ackMail(to, leaseMail(to, 'read', () => true)?.lease ?? '')
}

const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ev-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ev-worker' })
const other = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'ev-other' })

const exited = new Set<string>()
const terminal = new Map<string, { running: boolean; lastExitCode?: number }>()
let line = 'w-1  done 1s'
const lineFor = vi.fn(async () => line)
const journal = new PaneJournal({ terminal: (id) => terminal.get(id), now: Date.now })
const events = new PaneEvents({
  identity: (paneId) => [boss, worker, other].find((p) => p.paneId === paneId),
  line: lineFor,
  exited: (paneId) => exited.has(paneId),
})
journal.subscribe(events.onJournal)

const attention = (paneId: string, state?: string) =>
  journal.onChange(paneId, { kind: 'attention', attention: { state } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  exited.clear()
  terminal.clear()
  lineFor.mockClear()
  line = 'w-1  done 1s'
  journal.forget(worker.paneId)
  journal.forget(other.paneId)
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('PaneEvents', () => {
  it('puts the watched pane’s status line into the subscriber’s inbox as one event, from the watched pane', async () => {
    watchPane(boss.externalId, worker.externalId, ['done'])
    attention(worker.paneId, 'working')
    attention(worker.paneId, 'done')
    await settle()
    const inbox = inboxOf(boss.externalId)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      kind: 'event',
      from: worker.externalId,
      to: boss.externalId,
      text: 'w-1  done 1s',
    })
    expect(lineFor).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: worker.externalId }),
      expect.objectContaining({ externalId: boss.externalId }),
    )
  })

  it('sends only the states the subscriber asked for', async () => {
    watchPane(boss.externalId, worker.externalId, ['error'])
    attention(worker.paneId, 'done')
    attention(worker.paneId, 'waiting')
    await settle()
    expect(inboxOf(boss.externalId)).toEqual([])
    attention(worker.paneId, 'error')
    await settle()
    expect(inboxOf(boss.externalId)).toHaveLength(1)
  })

  it('sends nothing to a pane that watches another pane, or to nobody', async () => {
    watchPane(boss.externalId, other.externalId, ['done'])
    attention(worker.paneId, 'done')
    await settle()
    expect(inboxOf(boss.externalId)).toEqual([])
    expect(lineFor).not.toHaveBeenCalled()
  })

  it('merges into an event that is still queued instead of stacking a second one', async () => {
    watchPane(boss.externalId, worker.externalId, ['done', 'waiting'])
    attention(worker.paneId, 'waiting')
    await settle()
    line = 'w-1  done 2s'
    attention(worker.paneId, 'done')
    await settle()
    const inbox = inboxOf(boss.externalId)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.text).toBe('w-1  done 1s\nw-1  done 2s')
  })

  it('starts a new event once the earlier one was taken', async () => {
    watchPane(boss.externalId, worker.externalId, ['done', 'waiting'])
    attention(worker.paneId, 'waiting')
    await settle()
    readAll(boss.externalId)
    attention(worker.paneId, 'done')
    await settle()
    expect(inboxOf(boss.externalId)).toHaveLength(1)
  })

  it('sends an event when a command finishes, and one when the pane exits, once each', async () => {
    watchPane(boss.externalId, worker.externalId, ['command', 'exited'])
    terminal.set(worker.paneId, { running: true })
    journal.onChange(worker.paneId, { kind: 'state' })
    terminal.set(worker.paneId, { running: false, lastExitCode: 1 })
    journal.onChange(worker.paneId, { kind: 'state' })
    await settle()
    expect(inboxOf(boss.externalId)).toHaveLength(1)
    readAll(boss.externalId)

    exited.add(worker.paneId)
    events.onChange(worker.paneId, { kind: 'state' })
    events.onChange(worker.paneId, { kind: 'state' })
    await settle()
    expect(inboxOf(boss.externalId)).toHaveLength(1)
    readAll(boss.externalId)

    exited.delete(worker.paneId)
    events.onChange(worker.paneId, { kind: 'state' })
    exited.add(worker.paneId)
    events.onChange(worker.paneId, { kind: 'state' })
    await settle()
    expect(inboxOf(boss.externalId)).toHaveLength(1)
  })

  it('does not fail the watched pane’s state change when the status line cannot be made', async () => {
    watchPane(boss.externalId, worker.externalId, ['done'])
    lineFor.mockRejectedValueOnce(new Error('listing failed'))
    attention(worker.paneId, 'done')
    await settle()
    expect(inboxOf(boss.externalId)).toEqual([])
  })
})
