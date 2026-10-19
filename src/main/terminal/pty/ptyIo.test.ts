import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { createPtyIo } from './ptyIo'
import type { PtyEntry } from './ptyRegistry'
import { resizeFromDesktop } from './ptySize'

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
  const entry = { pty, mirror, session, subs: new Map([['1', window]]) } as unknown as PtyEntry
  return { entry, window, pty, mirror, session }
}

describe('phone pty io', () => {
  it('tells the desktop windows the size a phone resized the pane to', () => {
    const { entry, window, mirror } = fakeEntry()
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    io.attachPhoneObserver('pane-1', { role: 'owner', sendData: () => undefined })?.resize(40, 20)
    expect(mirror.resize).toHaveBeenCalledWith(40, 20)
    expect(window.send).toHaveBeenCalledWith('pty:size:pane-1', 40, 20)
  })

  it('sends nothing when the phone asks for the size the pane already has', () => {
    const { entry, window, pty } = fakeEntry(80, 24)
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    io.attachPhoneObserver('pane-1', { role: 'owner', sendData: () => undefined })?.resize(80, 24)
    expect(pty.resize).not.toHaveBeenCalled()
    expect(window.send).not.toHaveBeenCalled()
  })

  it('replays the whole ring as dropped to a phone holding a cursor from an earlier pty', () => {
    const earlier = new PtySession()
    earlier.push('x'.repeat(3000))
    const phoneCursor = earlier.cursor - 1000
    const { entry, session } = fakeEntry(120, 40, new PtySession())
    session.push('y'.repeat(5000))
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    const sent: string[] = []
    const attached = io.attachPhoneObserver('pane-1', {
      sinceCursor: phoneCursor,
      sendData: (data) => sent.push(data),
    })
    expect(attached).toMatchObject({ dropped: true, cursor: session.cursor })
    expect(sent).toEqual(['y'.repeat(5000)])
  })

  describe('desktop size', () => {
    function phoneOn(cols = 120, rows = 40) {
      const fake = fakeEntry(cols, rows)
      const io = createPtyIo({ ptys: new Map([['pane-1', fake.entry]]) })
      const attach = (role: 'owner' | 'observer') =>
        io.attachPhoneObserver('pane-1', { role, sendData: () => undefined })
      return { ...fake, io, attach }
    }

    it('puts the desktop size back when the owner phone detaches', () => {
      const { entry, window, pty, attach } = phoneOn(120, 40)
      resizeFromDesktop(entry, 100, 30)
      const owner = attach('owner')
      owner?.resize(44, 20)
      expect(pty.cols).toBe(44)
      owner?.detach()
      expect([pty.cols, pty.rows]).toEqual([100, 30])
      expect(window.send).toHaveBeenLastCalledWith('pty:size:pane-1', 100, 30)
    })

    it('falls back to the size the pane had when the phone attached', () => {
      const { pty, attach } = phoneOn(120, 40)
      const owner = attach('owner')
      owner?.resize(44, 20)
      owner?.detach()
      expect([pty.cols, pty.rows]).toEqual([120, 40])
    })

    it('restores once even when the phone detaches twice', () => {
      const { window, attach } = phoneOn(120, 40)
      const owner = attach('owner')
      owner?.resize(44, 20)
      owner?.detach()
      owner?.detach()
      expect(window.send).toHaveBeenCalledTimes(2)
    })

    it('never resizes a pane the phone did not resize', () => {
      const { pty, window, attach } = phoneOn(120, 40)
      attach('owner')?.detach()
      attach('observer')?.detach()
      expect(pty.resize).not.toHaveBeenCalled()
      expect(window.send).not.toHaveBeenCalled()
    })

    it('leaves the pane alone when an observer detaches', () => {
      const { entry, pty, attach } = phoneOn(120, 40)
      resizeFromDesktop(entry, 100, 30)
      const owner = attach('owner')
      owner?.resize(44, 20)
      attach('observer')?.detach()
      expect(pty.cols).toBe(44)
    })

    it('keeps the desktop size when the desktop was the last to resize', () => {
      const { entry, pty, attach } = phoneOn(120, 40)
      const owner = attach('owner')
      owner?.resize(44, 20)
      resizeFromDesktop(entry, 100, 30)
      owner?.detach()
      expect([pty.cols, pty.rows]).toEqual([100, 30])
      expect(pty.resize).toHaveBeenCalledTimes(2)
    })

    it('keeps the size another phone holds when one phone detaches', () => {
      const { pty, attach } = phoneOn(120, 40)
      const a = attach('owner')
      const b = attach('owner')
      a?.resize(44, 20)
      b?.resize(50, 22)
      a?.detach()
      expect([pty.cols, pty.rows]).toEqual([50, 22])
      b?.detach()
      expect([pty.cols, pty.rows]).toEqual([120, 40])
    })

    it('restores when the holding phone detaches and another owner stays', () => {
      const { pty, attach } = phoneOn(120, 40)
      const a = attach('owner')
      attach('owner')
      a?.resize(44, 20)
      a?.detach()
      expect([pty.cols, pty.rows]).toEqual([120, 40])
    })

    it('never lets an observer resize the pane', () => {
      const { pty, attach } = phoneOn(120, 40)
      attach('observer')?.resize(44, 20)
      expect(pty.resize).not.toHaveBeenCalled()
    })

    it('never records a 0x0 desktop size', () => {
      const { entry, pty, attach } = phoneOn(120, 40)
      const owner = attach('owner')
      owner?.resize(44, 20)
      resizeFromDesktop(entry, 0, 0)
      owner?.resize(44, 20)
      owner?.detach()
      expect([pty.cols, pty.rows]).toEqual([120, 40])
    })
  })
})
