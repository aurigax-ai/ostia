import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { createLiveAttach } from './ptyLiveAttach'
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
