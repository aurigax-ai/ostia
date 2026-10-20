import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { createPtyIo } from './ptyIo'
import type { PtyEntry } from './ptyRegistry'
import { releasePty, resizePty } from './ptySize'

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
    hold: null,
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
    return { ...fake, io, handle, sizes }
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

  describe('size hold', () => {
    it('sizes the pty to the phone grid and tells the desktop windows it is held', () => {
      const { handle, pty, mirror, window } = attached('owner')
      expect(handle?.hold(44, 20)).toBe('ok')
      expect([pty.cols, pty.rows]).toEqual([44, 20])
      expect(mirror.resize).toHaveBeenCalledWith(44, 20)
      expect(window.send).toHaveBeenCalledWith('pty:size:pane-1', 44, 20, true)
    })

    it('gives the desktop size back on release and tells the windows it is free', () => {
      const { handle, pty, window } = attached('owner', 100, 30)
      handle?.hold(44, 20)
      handle?.release()
      expect([pty.cols, pty.rows]).toEqual([100, 30])
      expect(window.send).toHaveBeenLastCalledWith('pty:size:pane-1', 100, 30, false)
    })

    it('gives the desktop size back when the phone detaches, and only once', () => {
      const { handle, pty, window } = attached('owner', 100, 30)
      handle?.hold(44, 20)
      handle?.detach()
      handle?.detach()
      expect([pty.cols, pty.rows]).toEqual([100, 30])
      expect(window.send).toHaveBeenCalledTimes(2)
    })

    it('refuses a second holder and leaves the first grid in place', () => {
      const first = attached('owner', 100, 30)
      const second = first.io.attachPhoneObserver('pane-1', {
        role: 'owner',
        sendData: () => undefined,
        sendSize: () => undefined,
      })
      expect(first.handle?.hold(44, 20)).toBe('ok')
      expect(second?.hold(60, 20)).toBe('held-by-other')
      expect([first.pty.cols, first.pty.rows]).toEqual([44, 20])
      second?.release()
      second?.detach()
      expect([first.pty.cols, first.pty.rows]).toEqual([44, 20])
    })

    it('keeps the first desktop size when the holder holds again at a new grid', () => {
      const { handle, pty } = attached('owner', 100, 30)
      handle?.hold(44, 20)
      handle?.hold(60, 18)
      expect([pty.cols, pty.rows]).toEqual([60, 18])
      handle?.release()
      expect([pty.cols, pty.rows]).toEqual([100, 30])
    })

    it('lets another phone hold once the first released', () => {
      const first = attached('owner', 100, 30)
      const second = first.io.attachPhoneObserver('pane-1', {
        role: 'owner',
        sendData: () => undefined,
        sendSize: () => undefined,
      })
      first.handle?.hold(44, 20)
      first.handle?.release()
      expect(second?.hold(60, 20)).toBe('ok')
    })

    it('puts the desktop size back when the pane program exits', () => {
      const { handle, entry, pty, window } = attached('owner', 100, 30)
      handle?.hold(44, 20)
      releasePty('pane-1', entry)
      expect([pty.cols, pty.rows]).toEqual([100, 30])
      expect(window.send).toHaveBeenLastCalledWith('pty:size:pane-1', 100, 30, false)
    })

    it('never touches the size of a pane nobody held', () => {
      const { handle, pty, window } = attached('owner')
      handle?.release()
      handle?.detach()
      expect(pty.resize).not.toHaveBeenCalled()
      expect(window.send).not.toHaveBeenCalled()
    })
  })
})
