import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { createPtyIo } from './ptyIo'
import type { PtyEntry } from './ptyRegistry'
import { resizePty } from './ptySize'

function fakeEntry(cols = 120, rows = 40, session = new PtySession()) {
  const window = { isDestroyed: () => false, send: vi.fn() }
  const pty = {
    cols,
    rows,
    write: vi.fn(),
    resize: vi.fn((c: number, r: number) => {
      pty.cols = c
      pty.rows = r
    }),
  }
  const mirror = { resize: vi.fn() }
  const entry = {
    pty,
    mirror,
    session,
    subs: new Map([['1', window]]),
    sizeListeners: new Set(),
  } as unknown as PtyEntry
  return { entry, window, pty, mirror, session }
}

describe('phone pty io', () => {
  function attached(role?: 'owner' | 'observer', cols = 120, rows = 40) {
    const fake = fakeEntry(cols, rows)
    const io = createPtyIo({ ptys: new Map([['pane-1', fake.entry]]) })
    const sizes: Array<[number, number]> = []
    const handle = io.attachPhoneObserver('pane-1', {
      role,
      sendData: () => undefined,
      sendSize: (c, r) => sizes.push([c, r]),
    })
    return { ...fake, handle, sizes }
  }

  it('resizes the pty when the desktop resizes it', () => {
    const { entry, pty, mirror } = attached()
    resizePty(entry, 100, 30)
    expect([pty.cols, pty.rows]).toEqual([100, 30])
    expect(mirror.resize).toHaveBeenCalledWith(100, 30)
  })

  it.each(['owner', 'observer'] as const)(
    'tells an attached %s phone the size after a desktop resize',
    (role) => {
      const { entry, sizes } = attached(role)
      resizePty(entry, 100, 30)
      resizePty(entry, 90, 25)
      expect(sizes).toEqual([
        [100, 30],
        [90, 25],
      ])
    },
  )

  it('tells a phone nothing when the desktop resize leaves the size unchanged', () => {
    const { entry, sizes } = attached('owner', 100, 30)
    resizePty(entry, 100, 30)
    expect(sizes).toEqual([])
  })

  it('stops telling a phone the size once it detaches', () => {
    const { entry, handle, sizes } = attached('owner')
    handle?.detach()
    resizePty(entry, 100, 30)
    expect(sizes).toEqual([])
  })

  it('returns the size the pane has at attach', () => {
    expect(attached('observer', 100, 30).handle).toMatchObject({ cols: 100, rows: 30 })
  })

  it('replays the whole ring as dropped to a phone holding a cursor from an earlier pty', () => {
    const earlier = new PtySession()
    earlier.push('x'.repeat(3000))
    const phoneCursor = earlier.cursor - 1000
    const { entry, session } = fakeEntry(120, 40, new PtySession())
    session.push('y'.repeat(5000))
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    const sent: string[] = []
    const handle = io.attachPhoneObserver('pane-1', {
      sinceCursor: phoneCursor,
      sendData: (data) => sent.push(data),
      sendSize: () => undefined,
    })
    expect(handle).toMatchObject({ dropped: true, cursor: session.cursor })
    expect(sent).toEqual(['y'.repeat(5000)])
  })
})
