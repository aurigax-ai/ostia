import { describe, expect, it } from 'vitest'
import { ScreenTitleFilter } from './screenTitleFilter'
import { TmuxPane } from './tmuxPane'

const server = {
  send: () => {},
  command: async () => [],
  batch: async () => [],
  forget: () => {},
  killWindow: async () => {},
}

function pane(): { pane: TmuxPane; seen: string[] } {
  const p = new TmuxPane(server, '@1', '%1', 1, 80, 24)
  const seen: string[] = []
  p.onData((d) => seen.push(d))
  return { pane: p, seen }
}

describe('ScreenTitleFilter', () => {
  it('strips ESC k title ESC \\ in one chunk', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1bkpwd\x1b\\b')).toBe('ab')
  })

  it('strips the sequence split across chunks at every offset', () => {
    const input = 'a\x1bkcd /tmp\x1b\\b'
    for (let i = 1; i < input.length; i++) {
      const f = new ScreenTitleFilter()
      expect(f.push(input.slice(0, i)) + f.push(input.slice(i))).toBe('ab')
    }
  })

  it('keeps OSC titles and other escapes unchanged', () => {
    const f = new ScreenTitleFilter()
    const input = '\x1b]0;title\x07\x1b]2;t\x1b\\\x1b[31mred\x1b[0m\x1bM'
    expect(f.push(input)).toBe(input)
  })

  it('does not end the title on BEL', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bkt\x07x\x1b\\y')).toBe('y')
  })

  it('drops an aborted title on CAN and resumes output', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bkabc\x18z')).toBe('z')
  })
})

describe('TmuxPane title filtering', () => {
  it('KSH-T1 never hands ESC k titles to listeners, also when split', () => {
    const { pane: p, seen } = pane()
    p.deliver('x\x1bkpw')
    p.deliver('d\x1b')
    p.deliver('\\y')
    expect(seen.join('')).toBe('xy')
  })

  it('filters early output replayed to the first listener', () => {
    const p = new TmuxPane(server, '@1', '%1', 1, 80, 24)
    p.unheard = '\x1bkls\x1b\\ok'
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(seen.join('')).toBe('ok')
  })
})
