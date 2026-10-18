import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_WAKES_MAX, MAIL_WAKES_WINDOW_MS } from '../../shared/agents/mailDelivery'
import type { PaneEntry } from '../panes/paneList'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-mailwake-'))
process.env.XDG_DATA_HOME = dataHome

const { createMailWaker } = await import('./mailWake')
const { enqueue, flushBus, onMailQueued, postEvent, resetBus } = await import('./busStore')
const { markManager, registerPane } = await import('../control/idRegistry')

const sleeper = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mw-sleeper' })
const sandboxedPane = registerPane({ windowId: 'w1', workspaceId: 'wsS', paneId: 'mw-sandboxed' })
const scratchPane = registerPane({ windowId: 'w1', workspaceId: 'wsX', paneId: 'mw-scratch' })
const awake = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mw-awake' })
const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'mw-manager' })
markManager('mw-manager')

const hibernated = new Set([sleeper, sandboxedPane, scratchPane, manager].map((p) => p.externalId))
const clock = { now: 1_000_000 }
const wake = vi.fn(async (_to: unknown) => ({ woke: true }))
const waking = { start: vi.fn(), abandon: vi.fn() }

onMailQueued(
  createMailWaker({
    panes: async () =>
      [sleeper, sandboxedPane, scratchPane, awake, manager].map(
        (p) =>
          ({
            paneId: p.externalId,
            hibernated: hibernated.has(p.externalId) ? true : undefined,
          }) as PaneEntry,
      ),
    wake,
    waking,
    isSandboxed: (workspaceId) => workspaceId === 'wsS',
    isScratch: (workspaceId) => workspaceId === 'wsX',
    now: () => clock.now,
  }),
)

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  wake.mockClear()
  wake.mockImplementation(async () => ({ woke: true }))
  waking.start.mockClear()
  waking.abandon.mockClear()
  clock.now += MAIL_WAKES_WINDOW_MS * 2
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('wake on mail', () => {
  it('wakes a hibernated agent pane through the wake path when a message arrives for it', async () => {
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'hello', wakes: true })
    await settle()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0][0]).toMatchObject({ externalId: sleeper.externalId })
    expect(waking.start).toHaveBeenCalledWith(sleeper.paneId)
    expect(waking.abandon).not.toHaveBeenCalled()
  })

  it('leaves the mail queued when the sender could not wake the pane itself', async () => {
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'hello' })
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake for an event', async () => {
    postEvent(awake.externalId, sleeper.externalId, 'w-1  done 1s')
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('never wakes an awake pane, a manager, a sandboxed workspace or a scratch one', async () => {
    for (const to of [awake, manager, sandboxedPane, scratchPane]) {
      enqueue({ from: 'ostia', to: to.externalId, text: 'hello', wakes: true })
    }
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake for a report Ostia sent on the human’s action', async () => {
    enqueue({ from: 'ostia', to: sleeper.externalId, text: '{"kind":"capture"}', quiet: true })
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('wakes a pane at most the maximum times an hour, and again once the hour passed', async () => {
    for (let i = 0; i < MAIL_WAKES_MAX + 2; i++) {
      enqueue({ from: 'ostia', to: sleeper.externalId, text: `m${i}`, wakes: true })
      await settle()
    }
    expect(wake).toHaveBeenCalledTimes(MAIL_WAKES_MAX)
    clock.now += MAIL_WAKES_WINDOW_MS + 1
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'later', wakes: true })
    await settle()
    expect(wake).toHaveBeenCalledTimes(MAIL_WAKES_MAX + 1)
  })

  it('keeps the wake count across a restart of the bus', async () => {
    for (let i = 0; i < MAIL_WAKES_MAX; i++) {
      enqueue({ from: 'ostia', to: sleeper.externalId, text: `m${i}`, wakes: true })
      await settle()
    }
    await flushBus()
    await resetBus()
    wake.mockClear()
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'after restart', wakes: true })
    await settle()
    expect(wake).not.toHaveBeenCalled()
  })

  it('gives the wake mark back when the wake did not happen, and survives a failing wake', async () => {
    wake.mockResolvedValueOnce({ woke: false })
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'one', wakes: true })
    await settle()
    expect(waking.abandon).toHaveBeenCalledWith(sleeper.paneId)
    wake.mockRejectedValueOnce(new Error('window gone'))
    enqueue({ from: 'ostia', to: sleeper.externalId, text: 'two', wakes: true })
    await settle()
    expect(waking.abandon).toHaveBeenCalledTimes(2)
  })
})
