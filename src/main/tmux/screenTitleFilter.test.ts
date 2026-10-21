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

  it('ends the title at any ESC and parses what follows', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bkt\x1b[31my')).toBe('\x1b[31my')
  })

  it('keeps a colored prompt after an unterminated title', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1bkt\x1b[31mred\x1b[0m$ ')).toBe('a\x1b[31mred\x1b[0m$ ')
  })

  it('keeps command output after a BEL inside the title', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bkvim\x07\x1b[32muser@host\x1b[0m $ ls\r\nfile\r\n')).toBe(
      '\x1b[32muser@host\x1b[0m $ ls\r\nfile\r\n',
    )
  })

  it('drops the first ESC of ESC ESC like tmux', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1b\x1bkt\x1b\\b')).toBe('ab')
  })

  it('starts a new title when ESC k follows inside a title', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bka\x1bkb\x1b\\c')).toBe('c')
  })

  it('keeps swallowing a title longer than any limit until ESC', () => {
    const f = new ScreenTitleFilter()
    const title = 'x'.repeat(2 * 1024 * 1024)
    expect(f.push(`\x1bk${title}`)).toBe('')
    expect(f.push('more\x1b\\ok')).toBe('ok')
  })

  it('treats ESC k after a C0 control as a title like tmux', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1b\nkt\x1b\\b')).toBe('a\nb')
  })

  it('ignores DEL after ESC like tmux and still starts a title', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1b\x7fkt\x1b\\b')).toBe('ab')
  })

  it('ignores every byte from DEL up after ESC, not only DEL', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1b\x7f\u00e9\u4e2dkt\x1b\\b')).toBe('ab')
  })

  it('ignores DEL after the ESC that ends a title', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1bkt\x1b\x7f\\ok')).toBe('ok')
  })

  it('swallows an ESC DEL k title split across chunks at every offset', () => {
    const input = 'a\x1b\x7fkcd /tmp\x1b\x7f\\b'
    for (let i = 1; i < input.length; i++) {
      const f = new ScreenTitleFilter()
      expect(f.push(input.slice(0, i)) + f.push(input.slice(i))).toBe('ab')
    }
  })

  it('drops bytes from DEL up after ESC and keeps the sequence that follows', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('a\x1b\x7fMb')).toBe('a\x1bMb')
  })

  it('does not hold CJK text after a stray ESC', () => {
    const f = new ScreenTitleFilter()
    expect(f.push('\x1b\u4e2d\u6587\r\n\u4e2d\u6587\r\n')).toBe('\r\n\r\n')
    for (let i = 0; i < 1000; i++) expect(f.push('\u4e2d\u6587\u4e2d\u6587\r\n')).toBe('\r\n')
    expect(f.push('x')).toBe('\x1bx')
  })

  it('returns plain text unchanged', () => {
    const f = new ScreenTitleFilter()
    const input = 'plain \u00e9\u4e2d\r\n'
    expect(f.push(input)).toBe(input)
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
    p.holdEarlyOutput('\x1bkls\x1b\\ok')
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(seen.join('')).toBe('ok')
  })

  it('filters early output before later output arrives', () => {
    const p = new TmuxPane(server, '@1', '%1', 1, 80, 24)
    p.holdEarlyOutput('ok')
    p.deliver('\x1bkt')
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(seen.join('')).toBe('ok')
  })

  it('feeds skipped early output to the filter so a title begun in it does not leak', () => {
    const p = new TmuxPane(server, '@1', '%1', 1, 80, 24)
    p.skipEarlyOutput('before\x1bkls')
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    p.deliver('-la\x1b\\after')
    expect(seen.join('')).toBe('after')
  })

  it('does not replay skipped early output to the first listener', () => {
    const p = new TmuxPane(server, '@1', '%1', 1, 80, 24)
    p.skipEarlyOutput('before')
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    expect(seen).toEqual([])
  })

  it('releases output held during a snapshot without filtering it twice', async () => {
    const p = new TmuxPane(
      { ...server, batch: async (lines: string[]) => lines.map(() => ['0']) },
      '@1',
      '%1',
      1,
      80,
      24,
    )
    const seen: string[] = []
    p.onData((d) => seen.push(d))
    await p.snapshot(80, 24)
    p.deliver('hello\x1bkti')
    p.live()
    p.deliver('tle\x1b\\!')
    expect(seen.join('')).toBe('hello!')
  })
})
