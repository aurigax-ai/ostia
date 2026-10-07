import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type GhosttyTerminal,
  createGhosttyTerminal,
  loadGhosttyEngine,
  oneBasedLinks,
  osc52Data,
  promptMarkData,
  unknownOsc,
} from './ghosttyTerminal'

const realGetContext = HTMLCanvasElement.prototype.getContext

function stubContext(canvas: HTMLCanvasElement): unknown {
  const noop = () => {}
  return new Proxy(
    { canvas, measureText: (text: string) => ({ width: text.length * 8 }) },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
      set: () => true,
    },
  )
}

let created: GhosttyTerminal | null = null

function open(): GhosttyTerminal {
  created = createGhosttyTerminal({ fontSize: 13, scrollback: 1000 }, false, {
    activate: () => {},
    hover: () => {},
    leave: () => {},
  })
  created.term.open(document.createElement('div'))
  return created
}

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return kind === '2d' ? stubContext(this) : null
  } as typeof HTMLCanvasElement.prototype.getContext
  await loadGhosttyEngine()
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext
})

afterEach(() => {
  created?.term.dispose()
  created = null
})

describe('Ghostty terminal adapter', () => {
  it('turns prompt events back into the OSC 133 data xterm hands its parser', () => {
    expect(promptMarkData({ kind: 'prompt-start', command: '' })).toBe('A')
    expect(promptMarkData({ kind: 'command-end', exitCode: 2, command: '' })).toBe('D;2')
    expect(promptMarkData({ kind: 'command-end', command: '' })).toBe('D')
    expect(unknownOsc('633;E;ls -la')).toEqual({ ident: 633, data: 'E;ls -la' })
    expect(unknownOsc('99')).toEqual({ ident: 99, data: '' })
    expect(unknownOsc('x;1')).toBeNull()
    expect(atob(osc52Data('héllo').slice(2))).toBe('h\xc3\xa9llo')
  })

  it('delivers shell integration through registerOscHandler with the cursor exact', () => {
    const { term } = open()
    const seen: string[] = []
    term.parser.registerOscHandler(133, (data) => {
      seen.push(`133 ${data} @${term.buffer.active.cursorX}`)
      return true
    })
    for (const ident of [7, 9, 633, 777]) {
      term.parser.registerOscHandler(ident, (data) => {
        seen.push(`${ident} ${data}`)
        return true
      })
    }
    term.write('\x1b]7;file://box/home/me\x07\x1b]133;A\x07$ \x1b]133;B\x07')
    term.write('\x1b]633;E;ls\x07\x1b]133;C\x07\x1b]133;D;1\x07')
    term.write('\x1b]777;notify;Build;done\x07\x1b]9;tests passed\x07')
    expect(seen).toEqual([
      '7 file://box/home/me',
      '133 A @0',
      '133 B @2',
      '633 E;ls',
      '133 C @2',
      '133 D;1 @2',
      '777 notify;Build;done',
      '9 tests passed',
    ])
  })

  it('hands OSC 52 writes to the host handler and never lets Ghostty answer them', () => {
    const { term } = open()
    const writes: string[] = []
    term.parser.registerOscHandler(52, (data) => {
      writes.push(data)
      return true
    })
    term.write('\x1b]52;c;aGVsbG8=\x07')
    expect(writes).toEqual(['c;aGVsbG8='])
  })

  it('keeps a marker on its line as output scrolls', () => {
    const { term } = open()
    term.write('\x1b]133;A\x07$ marked\r\n')
    const marker = term.registerMarker(-1)
    const line = marker?.line
    for (let i = 0; i < 80; i++) term.write(`out ${i}\r\n`)
    expect(marker?.line).toBe(line)
    expect(term.buffer.active.getLine(line ?? -1)?.translateToString(true)).toBe('$ marked')
  })

  it('draws no frame while paused, keeps parsing, and redraws once on resume', async () => {
    const ghostty = open()
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const renders: unknown[] = []
    ghostty.term.onRender((range) => renders.push(range))
    ghostty.setPaused(true)
    for (let i = 0; i < 5; i++) {
      ghostty.term.write(`hidden ${i}\r\n`)
      await frame()
    }
    expect(renders).toHaveLength(0)
    expect(ghostty.term.buffer.active.getLine(4)?.translateToString(true)).toBe('hidden 4')

    ghostty.setPaused(false)
    expect(renders).toEqual([{ start: 0, end: ghostty.term.rows - 1 }])
  })

  it('stops answering terminal queries while shells are kept in tmux', () => {
    const ghostty = open()
    const sent: string[] = []
    ghostty.term.onData((d) => sent.push(d))
    ghostty.term.write('\x1b[6n')
    const silence = ghostty.silenceQueryReplies()
    ghostty.term.write('\x1b[6n')
    silence.dispose()
    ghostty.term.write('\x1b[6n')
    expect(sent).toEqual(['\x1b[1;1R', '\x1b[1;1R'])
  })

  it('maps xterm.js 1-based link lines and ranges onto Ghostty 0-based ones', () => {
    const activate = vi.fn()
    const provider = oneBasedLinks(
      {
        provideLinks: (y, callback) =>
          callback([{ text: 'a.ts', range: { start: { x: 3, y }, end: { x: 6, y } }, activate }]),
      },
      () => true,
    )
    let links: { range: { start: { x: number; y: number } } }[] | undefined
    provider.provideLinks(4, (l) => {
      links = l
    })
    expect(links?.[0]?.range.start).toEqual({ x: 2, y: 4 })
  })
})
