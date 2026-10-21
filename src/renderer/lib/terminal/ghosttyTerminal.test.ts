import { Ghostty, Terminal as GhosttyTerm } from '@aurigax-ai/ghostty-web'
import wasmDataUrl from '@aurigax-ai/ghostty-web/ghostty-vt.wasm?inline'
import { Terminal as Xterm } from '@xterm/xterm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  createGhosttyTerminal,
  type GhosttyTerminal,
  loadGhosttyEngine,
  oneBasedLinks,
  osc52Data,
  promptMarkData,
  unknownOsc,
} from './ghosttyTerminal'
import { logicalLinesFrom } from './historyPages'
import type { OstiaTerminal } from './ostiaTerminal'
import { attachSmoothScroll, createWheelClassifier, SMOOTH_SCROLL_MS } from './smoothScroll'

interface WasmCells {
  getScrollbackLine(offset: number): unknown
}

const fills: string[] = []
const realGetContext = HTMLCanvasElement.prototype.getContext

function stubContext(canvas: HTMLCanvasElement): unknown {
  const noop = () => {}
  return new Proxy(
    { canvas, measureText: (text: string) => ({ width: text.length * 8 }) },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
      set: (_target, key, value) => {
        if (key === 'fillStyle') fills.push(String(value))
        return true
      },
    },
  )
}

let created: GhosttyTerminal | null = null

function open(gpu = false): GhosttyTerminal {
  created = createGhosttyTerminal(
    { fontSize: 13, scrollback: 1000, smoothScrollDuration: 0 },
    gpu,
    {
      activate: () => {},
      hover: () => {},
      leave: () => {},
    },
  )
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

const cleanups: (() => void)[] = []
let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeEach(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  useSettingsStore.setState(settingsInit, true)
  created?.term.dispose()
  created = null
  fills.length = 0
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

  it('keeps drawing on the canvas renderer when GPU acceleration is on but WebGL is missing', () => {
    const ghostty = open(true)
    const renders: unknown[] = []
    ghostty.term.onRender((range) => renders.push(range))
    ghostty.setPaused(false)
    ghostty.term.write('shown\r\n')
    expect(renders).toEqual([{ start: 0, end: ghostty.term.rows - 1 }])
    ghostty.setPaused(true)
    ghostty.setPaused(false)
    expect(renders).toHaveLength(2)
    expect(ghostty.term.buffer.active.getLine(0)?.translateToString(true)).toBe('shown')
  })

  it('relies on a released-renderer flag that ghostty-web still has', async () => {
    const wasm = Uint8Array.from(atob(wasmDataUrl.split(',')[1]), (c) => c.charCodeAt(0))
    const term = new GhosttyTerm({ ghostty: await Ghostty.fromBytes(wasm) })
    expect(Object.hasOwn(term, 'rendererReleased')).toBe(true)
    term.dispose()
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

  function wheel(
    target: Element,
    init: WheelEventInit,
    legacy: { wheelDeltaX?: number; wheelDeltaY?: number } = {},
  ): void {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    Object.defineProperty(e, 'wheelDeltaX', { value: legacy.wheelDeltaX ?? 0 })
    Object.defineProperty(e, 'wheelDeltaY', { value: legacy.wheelDeltaY ?? 0 })
    target.dispatchEvent(e)
  }

  function openInDocument(): { ghostty: OstiaTerminal; host: HTMLElement; target: Element } {
    created = createGhosttyTerminal(
      { fontSize: 13, scrollback: 1000, smoothScrollDuration: 0 },
      false,
      { activate: () => {}, hover: () => {}, leave: () => {} },
    )
    const host = document.createElement('div')
    document.body.append(host)
    cleanups.push(() => host.remove())
    created.term.open(host)
    return { ghostty: created.term, host, target: host.querySelector('canvas') ?? host }
  }

  const notch = { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: -100 }
  const notchLegacy = { wheelDeltaY: 120 }

  it('decides the scroll duration before ghostty reads it for the same wheel event', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
    const { ghostty, host, target } = openInDocument()
    const seen: number[] = []
    ghostty.attachCustomWheelEventHandler(() => {
      seen.push(ghostty.options.smoothScrollDuration ?? -1)
      return true
    })
    cleanups.push(attachSmoothScroll(host, ghostty, false, createWheelClassifier()))
    wheel(target, notch, notchLegacy)
    for (let i = 0; i < 5; i++) {
      wheel(target, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: -3 }, { wheelDeltaY: 9 })
    }
    expect(seen[0]).toBe(SMOOTH_SCROLL_MS)
    expect(seen.at(-1)).toBe(0)
  })

  it('keeps a running ghostty animation finite when a wheel event it does not scroll on arrives', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    const { ghostty, host, target } = openInDocument()
    ghostty.write('line\r\n'.repeat(200))
    cleanups.push(attachSmoothScroll(host, ghostty, false, createWheelClassifier()))
    wheel(target, notch, notchLegacy)
    wheel(target, notch, notchLegacy)
    expect(ghostty.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    for (let i = 0; i < 4; i++) {
      wheel(
        target,
        { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaX: 3, deltaY: 0 },
        { wheelDeltaX: -10 },
      )
    }
    expect(ghostty.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    for (let i = 0; i < 60 && frames.length > 0; i++) frames.shift()?.(performance.now())
    expect(Number.isFinite(ghostty.buffer.active.viewportY)).toBe(true)
    expect(ghostty.buffer.active.viewportY).toBeGreaterThan(0)
  })

  it('snaps a running ghostty animation to its target when a trackpad event sets the duration to 0', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    const { ghostty, host, target } = openInDocument()
    ghostty.write('line\r\n'.repeat(200))
    cleanups.push(attachSmoothScroll(host, ghostty, false, createWheelClassifier()))
    wheel(target, notch, notchLegacy)
    expect(ghostty.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    ghostty.options.smoothScrollDuration = 0
    for (let i = 0; i < 5 && frames.length > 0; i++) frames.shift()?.(performance.now())
    const y = ghostty.buffer.active.viewportY
    expect(Number.isFinite(y)).toBe(true)
    expect(y).toBeGreaterThan(0)
  })

  it('starts both engines with no scroll animation and gives them the same value per wheel event', () => {
    const { ghostty, host: ghosttyHost, target } = openInDocument()
    const xterm = new Xterm({ smoothScrollDuration: 0, allowProposedApi: true })
    const xtermHost = document.createElement('div')
    document.body.append(xtermHost)
    cleanups.push(
      () => xtermHost.remove(),
      () => xterm.dispose(),
    )
    expect(ghostty.options.smoothScrollDuration).toBe(0)
    expect(xterm.options.smoothScrollDuration).toBe(0)
    cleanups.push(
      attachSmoothScroll(ghosttyHost, ghostty, false, createWheelClassifier()),
      attachSmoothScroll(xtermHost, xterm, false, createWheelClassifier()),
    )
    const both = (init: WheelEventInit, legacy: { wheelDeltaY: number }): number[] => {
      wheel(target, init, legacy)
      wheel(xtermHost, init, legacy)
      return [ghostty.options.smoothScrollDuration ?? -1, xterm.options.smoothScrollDuration ?? -1]
    }
    const trackpad = (dy: number) =>
      both({ deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: dy }, { wheelDeltaY: -3 * dy })

    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
    expect(both(notch, notchLegacy)).toEqual([SMOOTH_SCROLL_MS, SMOOTH_SCROLL_MS])

    for (const dy of [45, 52, 61, 52]) trackpad(dy)
    expect(trackpad(40)).toEqual([0, 0])

    for (let i = 0; i < 5; i++) both(notch, notchLegacy)
    useSettingsStore.getState().setByPath('appearance.motion', 'reduced')
    expect(both(notch, notchLegacy)).toEqual([0, 0])

    useSettingsStore.getState().setByPath('appearance.motion', 'full')
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: false })
    expect(both(notch, notchLegacy)).toEqual([0, 0])
  })

  it('counts the matches of a search in the output and steps through them', () => {
    const { term, search } = open()
    term.write('one zqneedle\r\ntwo\r\nZQNEEDLE three\r\nfour zqneedle\r\n')
    const seen: string[] = []
    search.onDidChangeResults((r) => seen.push(`${r.resultIndex + 1}/${r.resultCount}`))
    const options = {
      decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#ff0' },
    }
    search.findNext('zqneedle', options)
    search.findNext('zqneedle', options)
    search.findPrevious('zqneedle', options)
    search.findNext('zqabsent', options)
    expect(seen).toEqual(['1/3', '2/3', '1/3', '0/0'])
  })

  it('paints an open terminal with the colors of a new theme', async () => {
    const { term } = open()
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    term.write('themed\r\n')
    await frame()
    fills.length = 0
    term.options.theme = { background: '#fdf6e3', foreground: '#657b83' }
    term.write('again\r\n')
    await frame()
    expect(fills).toContain('#fdf6e3')
  })
})

describe('Ghostty buffer rows', () => {
  it('counts the live buffer without reading the cells of any row', async () => {
    const { term } = open()
    await new Promise<void>((done) => {
      term.write(Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join(''), done)
    })
    const wasm = (term.buffer.normal as unknown as { terminal: { wasmTerm: WasmCells } }).terminal
      .wasmTerm
    const cells = vi.spyOn(wasm, 'getScrollbackLine')
    expect(term.buffer.normal.baseY).toBeGreaterThan(200)
    expect(logicalLinesFrom(term.buffer.normal, 0)).toBe(300)
    expect(cells).not.toHaveBeenCalled()
    expect(term.buffer.normal.getLine(10)?.translateToString(true)).toBe('line 10')
    expect(cells).toHaveBeenCalledTimes(1)
  })
})
