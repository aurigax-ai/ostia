import { describe, expect, it, vi } from 'vitest'
import { PtySession } from '../ptySession'
import { createPtyIo } from './ptyIo'
import type { PtyEntry } from './ptyRegistry'

function fakeEntry(cols = 120, rows = 40) {
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
  const session = new PtySession()
  const entry = { pty, mirror, session, subs: new Map([['1', window]]) } as unknown as PtyEntry
  return { entry, window, pty, mirror, session }
}

describe('phone pty io', () => {
  it('tells the desktop windows the size a phone resized the pane to', () => {
    const { entry, window, mirror } = fakeEntry()
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    io.ptyResize('pane-1', 40, 20)
    expect(mirror.resize).toHaveBeenCalledWith(40, 20)
    expect(window.send).toHaveBeenCalledWith('pty:size:pane-1', 40, 20)
  })

  it('sends nothing when the phone asks for the size the pane already has', () => {
    const { entry, window, pty } = fakeEntry(80, 24)
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    io.ptyResize('pane-1', 80, 24)
    expect(pty.resize).not.toHaveBeenCalled()
    expect(window.send).not.toHaveBeenCalled()
  })

  it('replays the whole ring as dropped to a phone holding a cursor from an earlier pty', () => {
    const { entry, session } = fakeEntry()
    session.push('after restart\r\n')
    const io = createPtyIo({ ptys: new Map([['pane-1', entry]]) })
    const sent: string[] = []
    const attached = io.attachPhoneObserver('pane-1', {
      sinceCursor: 9000,
      sendData: (data) => sent.push(data),
    })
    expect(attached).toMatchObject({ dropped: true, cursor: 'after restart\r\n'.length })
    expect(sent).toEqual(['after restart\r\n'])
  })
})
