import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { HIBERNATE_SEAM, HISTORY_LINES, RESTORE_SEAM, ScreenMirror } from './screenMirror'

const WIDE = 127
const NARROW = 90
const ESC = '\x1b'
const ST = `${ESC}\\`
const DIR = '~/proj main'

const mark = (kind: string) => `${ESC}]133;${kind}${ST}`
const promptSp = (cols: number) => `${ESC}[7m%${ESC}[27m${' '.repeat(cols - 1)}\r \r`
const rightPrompt = (clock: string) =>
  `${DIR}${ESC}[${WIDE - DIR.length - clock.length}C${ESC}[2m${clock}${ESC}[0m\r\n❯ ${mark('B')}`
const promptLines = (clock: string) => `\r\n${rightPrompt(clock)}`
const redrawPrompt = (clock: string) => `\r${ESC}[1A${ESC}[J${rightPrompt(clock)}`
const precmd = (exit: number | null) =>
  `${exit === null ? '' : mark(`D;${exit}`)}${mark('A')}${promptSp(WIDE)}`

function zshSession(): string {
  return [
    precmd(null),
    promptLines('12:40:41'),
    redrawPrompt('12:40:42'),
    'echo MARKER-OUT',
    `\r\n${mark('C')}`,
    'MARKER-OUT\r\n',
    precmd(0),
    promptLines('12:41:05'),
    redrawPrompt('12:41:06'),
  ].join('')
}

async function screenText(data: string, cols: number, rows = 30): Promise<string[]> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(data, resolve))
  const lines: string[] = []
  for (let i = 0; i < term.buffer.active.length; i++) {
    lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '')
  }
  term.dispose()
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

async function mirrored(data: string, cols = WIDE, rows = 30): Promise<ScreenMirror> {
  const mirror = new ScreenMirror(cols, rows)
  mirror.write(data)
  await mirror.flush()
  return mirror
}

async function serialized(data: string, cols = WIDE, rows = 30): Promise<string> {
  const mirror = await mirrored(data, cols, rows)
  const out = mirror.serialize()
  mirror.dispose()
  return out
}

describe('ScreenMirror', () => {
  it('garbles when the raw zsh stream is replayed at another width', async () => {
    const lines = await screenText(zshSession(), NARROW)
    expect(lines.some((l) => l.trim() === '%')).toBe(true)
  })

  it('serializes a p10k session into history that replays cleanly at a narrower width', async () => {
    const lines = await screenText(await serialized(zshSession()), NARROW)
    expect(lines.some((l) => l.includes('%'))).toBe(false)
    expect(lines.filter((l) => l.includes('MARKER-OUT'))).toHaveLength(2)
    expect(lines.filter((l) => l.includes(DIR))).toHaveLength(1)
    const text = lines.join('\n')
    expect(text).not.toContain('12:40:41')
    expect(text).not.toContain('12:41')
  })

  it('keeps a right-aligned clock whole at narrower and wider widths', async () => {
    const history = await serialized(zshSession())
    for (const cols of [NARROW, WIDE, 200]) {
      const clockLines = (await screenText(history, cols)).filter((l) => /\d:\d/.test(l))
      expect(clockLines).toHaveLength(1)
      expect(clockLines[0]).toContain('12:40:42')
    }
  })

  it('lays history out exactly as the original screen at the original width', async () => {
    const history = await serialized(zshSession())
    expect(await screenText(history, WIDE)).toEqual([
      `${DIR}${' '.repeat(WIDE - DIR.length - 8)}12:40:42`,
      '❯ echo MARKER-OUT',
      'MARKER-OUT',
    ])
  })

  it('emits no cursor movement, only text and SGR', async () => {
    const history = await serialized(zshSession())
    const controls = history.match(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g')) ?? []
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.every((c) => c.endsWith('m'))).toBe(true)
    expect(history.includes(`${ESC}]`)).toBe(false)
  })

  it('keeps colors and ends with an SGR reset', async () => {
    const history = await serialized(`${ESC}[31mred${ESC}[0m plain ${ESC}[38;2;1;2;3mrgb`)
    expect(history).toBe(`${ESC}[0;31mred${ESC}[0m plain ${ESC}[0;38;2;1;2;3mrgb${ESC}[0m`)
  })

  it('joins soft-wrapped rows into one line that rewraps at the new width', async () => {
    const history = await serialized(`${'x'.repeat(50)}\r\nnext`, 20, 10)
    expect(history).toBe(`${'x'.repeat(50)}\r\nnext`)
  })

  it('keeps the whole screen while a command is still running', async () => {
    const history = await serialized(
      `${precmd(null)}${promptLines('09:00:00')}sleep 5\r\n${mark('C')}working`,
    )
    const lines = await screenText(history, WIDE)
    expect(lines[lines.length - 1]).toBe('working')
    expect(lines.some((l) => l.startsWith('❯ sleep 5'))).toBe(true)
  })

  it('keeps output that lacks a trailing newline', async () => {
    const lines = await screenText(await serialized(`${mark('C')}partial${precmd(0)}`), WIDE)
    expect(lines[0].startsWith('partial')).toBe(true)
  })

  it('keeps everything when the shell has no integration marks', async () => {
    const lines = await screenText(await serialized('one\r\ntwo\r\n$ '), WIDE)
    expect(lines).toEqual(['one', 'two', '$'])
  })

  it('bounds the serialized history', async () => {
    const out = Array.from({ length: HISTORY_LINES + 200 }, (_, i) => `line ${i}`).join('\r\n')
    const lines = await screenText(await serialized(out, 40, 10), 40)
    expect(lines).toHaveLength(HISTORY_LINES)
    expect(lines[lines.length - 1]).toBe(`line ${HISTORY_LINES + 199}`)
  })

  it('applies resizes in order with the bytes written before them', async () => {
    const mirror = new ScreenMirror(80, 10)
    mirror.write(`${ESC}[70GX\r\n`)
    mirror.resize(40, 10)
    await mirror.flush()
    expect([mirror.cols, mirror.rows]).toEqual([40, 10])
    mirror.resize(0, 0)
    await mirror.flush()
    expect([mirror.cols, mirror.rows]).toEqual([40, 10])
    const history = mirror.serialize()
    mirror.dispose()
    expect(history).toBe(`${' '.repeat(69)}X`)
  })

  it('walks the buffer again only after the screen changed', async () => {
    const mirror = await mirrored('FIRST-OUT\r\n')
    const buffer = (mirror as unknown as { term: Terminal }).term.buffer.normal
    const reads = vi.spyOn(buffer, 'getLine')
    const first = mirror.serialize()
    const walked = reads.mock.calls.length
    expect(walked).toBeGreaterThan(0)
    expect(mirror.serialize()).toBe(first)
    expect(reads.mock.calls.length).toBe(walked)
    mirror.write('MORE-OUT\r\n')
    await mirror.flush()
    expect(mirror.serialize()).toContain('MORE-OUT')
    expect(reads.mock.calls.length).toBeGreaterThan(walked)
    mirror.dispose()
  })

  it('moves its revision on parsed output, a resize and a restore mark, never on a read', async () => {
    const mirror = await mirrored('out\r\n', 80, 10)
    const seen = [mirror.revision]
    mirror.serialize()
    seen.push(mirror.revision)
    mirror.resize(40, 10)
    await mirror.flush()
    seen.push(mirror.revision)
    mirror.markRestored('old')
    await mirror.flush()
    seen.push(mirror.revision)
    mirror.dispose()
    expect(seen[1]).toBe(seen[0])
    expect(seen[2]).toBeGreaterThan(seen[1])
    expect(seen[3]).toBeGreaterThan(seen[2])
  })

  it('ignores writes and serializes nothing once disposed', async () => {
    const mirror = await mirrored('before')
    mirror.dispose()
    mirror.write('after')
    await mirror.flush()
    expect(mirror.serialize()).toBe('')
  })
})

describe('ScreenMirror.screenText', () => {
  it('MGR-C31 returns the last lines of the active screen as plain text, joining wrapped rows', async () => {
    const mirror = new ScreenMirror(10, 5)
    mirror.write(`${ESC}[31mred${ESC}[0m line\r\n0123456789abc\r\nlast\r\n`)
    expect(await mirror.screenText(10)).toBe('red line\n0123456789abc\nlast')
    expect(await mirror.screenText(1)).toBe('last')
    mirror.dispose()
  })

  it('MGR-C31 reads a full-screen program on the alternate screen', async () => {
    const mirror = new ScreenMirror(20, 3)
    mirror.write('shell history\r\n')
    mirror.write(`${ESC}[?1049h${ESC}[Happroval? [y/n]`)
    expect(await mirror.screenText(50)).toBe('approval? [y/n]')
    mirror.dispose()
  })
})

describe('ScreenMirror.bracketedPaste', () => {
  it('follows the program turning bracketed paste on and off', async () => {
    const mirror = new ScreenMirror(80, 24)
    expect(mirror.bracketedPaste).toBe(false)
    mirror.write(`${ESC}[?2004h`)
    await mirror.flush()
    expect(mirror.bracketedPaste).toBe(true)
    mirror.write(`${ESC}[?2004l`)
    await mirror.flush()
    expect(mirror.bracketedPaste).toBe(false)
    mirror.dispose()
    expect(mirror.bracketedPaste).toBe(false)
  })
})

async function restoredRun(history: string, seam: string, after: string): Promise<string> {
  const mirror = new ScreenMirror(WIDE, 30)
  mirror.write(`${history}${seam}`)
  mirror.markRestored(history)
  mirror.write(after)
  await mirror.flush()
  const saved = mirror.serialize()
  mirror.dispose()
  return saved
}

const seams = (text: string, seam: string) => text.split(seam.slice(seam.indexOf('──'))).length - 1
const freshPrompt = (clock: string) => `${precmd(null)}${promptLines(clock)}`
const ranCommand = (clock: string) =>
  `${freshPrompt(clock)}ls\r\n${mark('C')}LS-OUT\r\n${precmd(0)}${promptLines(clock)}`

describe('ScreenMirror restored history', () => {
  it('saves the restored history unchanged while no command ran, restart after restart', async () => {
    const history = await serialized(zshSession())
    const first = await restoredRun(history, RESTORE_SEAM, freshPrompt('13:00:00'))
    const second = await restoredRun(first, RESTORE_SEAM, freshPrompt('13:05:00'))
    expect(first).toBe(history)
    expect(second).toBe(history)
    expect(seams(second, RESTORE_SEAM)).toBe(0)
  })

  it('keeps one seam before the output of a command run after the restore', async () => {
    const history = await serialized(zshSession())
    const used = await restoredRun(history, RESTORE_SEAM, ranCommand('13:00:00'))
    const idle = await restoredRun(used, RESTORE_SEAM, freshPrompt('13:05:00'))
    expect(idle).toBe(used)
    expect(seams(idle, RESTORE_SEAM)).toBe(1)
    const lines = await screenText(idle, WIDE)
    const seamLine = lines.findIndex((l) => l.includes('workspace restored'))
    expect(seamLine).toBeGreaterThan(lines.findIndex((l) => l === 'MARKER-OUT'))
    expect(lines.findIndex((l) => l === 'LS-OUT')).toBeGreaterThan(seamLine)
  })

  it('saves the restored history unchanged when the shell prints before its first prompt', async () => {
    const history = await serialized(zshSession())
    const greeting = 'To run a command as administrator, use "sudo <command>".\r\n'
    const first = await restoredRun(history, RESTORE_SEAM, `${greeting}${freshPrompt('13:00:00')}`)
    const second = await restoredRun(first, RESTORE_SEAM, `${greeting}${freshPrompt('13:05:00')}`)
    expect(first).toBe(history)
    expect(second).toBe(history)
  })

  it('does the same for a pane woken from hibernation', async () => {
    const history = await serialized(zshSession())
    const asleep = await restoredRun(history, HIBERNATE_SEAM, freshPrompt('13:00:00'))
    expect(asleep).toBe(history)
    const used = await restoredRun(asleep, HIBERNATE_SEAM, ranCommand('13:05:00'))
    expect(seams(used, HIBERNATE_SEAM)).toBe(1)
  })

  it('saves the whole screen once a shell without marks prints past the seam', async () => {
    const saved = await restoredRun('old', RESTORE_SEAM, 'new output\r\n$ ')
    const lines = await screenText(saved, WIDE)
    expect(lines).toEqual(['old', '── workspace restored ──', 'new output', '$'])
  })
})

describe('ScreenMirror cwdReport', () => {
  it('keeps the last folder the pane itself reported and ignores a malformed report', async () => {
    const mirror = new ScreenMirror(80, 24)
    expect(mirror.cwdReport).toBeNull()
    mirror.write('\x1b]7;file://box/home/u/proj\x07')
    mirror.write('\x1b]7;nonsense\x07')
    await mirror.flush()
    expect(mirror.cwdReport).toEqual({ host: 'box', path: '/home/u/proj' })
    mirror.dispose()
  })
})
