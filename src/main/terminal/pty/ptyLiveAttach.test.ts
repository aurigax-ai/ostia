import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { COVERED_REPLAY_MAX, createLiveAttach } from './ptyLiveAttach'
import type { PtyEntry } from './ptyRegistry'

function attach(hold: PtyEntry['hold']) {
  const entry = {
    pty: { cols: 44, rows: 20 },
    mirror: { blockSeqBase: 0 },
    session: new PtySession(),
    flow: { open: () => ({ sent: vi.fn(), close: vi.fn() }) },
    subs: new Map(),
    killTimer: null,
    shell: '/bin/zsh',
    sandboxed: false,
    sandboxStamp: null,
    kept: null,
    markNonce: null,
    hold,
  } as unknown as PtyEntry
  const live = createLiveAttach({
    windows: new Map(),
    movingPanes: new Set(),
    recoveryHeld: new Set(),
  })
  const sender = { id: 7, send: vi.fn(), isDestroyed: () => false }
  const e = { sender } as unknown as Electron.IpcMainInvokeEvent
  const mk = live.subscriberFor(e, 'p1', {} as never, '7')
  return live.attachExisting(entry, e, 'p1', {} as never, mk)
}

describe('attaching a window to a live pty', () => {
  it('tells the window the pane is held at a phone grid, so its notice and grid show after a reload', () => {
    expect(attach({ holder: 'gw-1', desktop: { cols: 100, rows: 30 } })).toMatchObject({
      cols: 44,
      rows: 20,
      held: true,
    })
  })

  it('says nothing of a hold when there is none', () => {
    expect(attach(null)).not.toHaveProperty('held')
  })
})

describe('a covered window', () => {
  function live() {
    const session = new PtySession()
    const entry = {
      pty: { cols: 80, rows: 24 },
      mirror: { blockSeqBase: 0 },
      session,
      flow: { open: () => ({ sent: vi.fn(), close: vi.fn() }) },
      subs: new Map(),
    } as unknown as PtyEntry
    const attachLive = createLiveAttach({
      windows: new Map(),
      movingPanes: new Set(),
      recoveryHeld: new Set(),
    })
    const sent: string[] = []
    const sender = {
      id: 7,
      send: (_channel: string, data: string) => sent.push(data),
      isDestroyed: () => false,
    }
    const e = { sender } as unknown as Electron.IpcMainInvokeEvent
    session.addLiveSubscriber(attachLive.subscriberFor(e, 'p1', {} as never, '7')(entry))
    return { session, sent }
  }

  it('gets no output while covered and all of it, in order, once uncovered', async () => {
    const { session, sent } = live()
    session.push('before ')
    await new Promise((resolve) => setImmediate(resolve))
    session.cover('7', true)
    session.push('one ')
    session.push('two ')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual(['before '])
    session.cover('7', false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual(['before ', 'one two '])
    session.push('after')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.join('')).toBe('before one two after')
  })

  it('still records the output for the scrollback while covered', () => {
    const { session } = live()
    session.cover('7', true)
    session.push('kept')
    expect(session.since(0).data).toBe('kept')
  })

  it('hands the backlog over before it outgrows the ring, then stays covered', async () => {
    const { session, sent } = live()
    session.cover('7', true)
    const chunk = 'x'.repeat(COVERED_REPLAY_MAX)
    session.push(chunk)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
    session.push('y')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.join('')).toBe(`${chunk}y`)
    session.push('z')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.join('')).toBe(`${chunk}y`)
    session.cover('7', false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent.join('')).toBe(`${chunk}yz`)
  })
})
