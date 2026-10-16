import { useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal } from './ostiaTerminal'

interface FakePane {
  term: Record<string, unknown>
  el: HTMLElement
  dispose: () => void
  top: number
  lines: string[]
  scrolledBy: number
}

const panes: FakePane[] = []

vi.mock('./historyLayerPane', () => ({
  createLayerPane: () => {
    const pane: FakePane = {
      el: document.createElement('div'),
      dispose: () => {},
      top: 0,
      lines: [],
      scrolledBy: 0,
      term: {},
    }
    pane.term = {
      cols: 80,
      rows: 10,
      reset: () => {
        pane.lines = []
      },
      write: (data: string, done?: () => void) => {
        pane.lines = data.split('\r\n')
        done?.()
      },
      resize: () => {},
      select: () => {},
      scrollToLine: (row: number) => {
        pane.top = row
      },
      scrollLines: (n: number) => {
        pane.scrolledBy += n
        pane.top += n
        scrollListeners.get(pane)?.()
      },
      onScroll: (listener: () => void) => {
        scrollListeners.set(pane, listener)
        return { dispose: () => {} }
      },
      buffer: {
        get active() {
          return {
            viewportY: pane.top,
            baseY: 0,
            length: pane.lines.length,
            getLine: (y: number) =>
              y < pane.lines.length
                ? { isWrapped: false, translateToString: () => pane.lines[y] }
                : undefined,
          }
        },
      },
    }
    panes.push(pane)
    return pane
  },
}))

const scrollListeners = new Map<FakePane, () => void>()

const { createHistoryScroll } = await import('./historyScroll')

const SEAM = 970

function liveTerminal() {
  const rows = 10
  const line = { isWrapped: false, translateToString: () => 'live line' }
  const buffer = {
    type: 'normal',
    viewportY: 0,
    baseY: 20,
    length: 30,
    getLine: (y: number) => (y < 30 ? line : undefined),
  }
  const term = {
    rows,
    cols: 80,
    modes: { mouseTrackingMode: 'none' },
    options: {},
    buffer: { active: buffer, normal: buffer, onBufferChange: () => ({ dispose: () => {} }) },
    onScroll: () => ({ dispose: () => {} }),
    onData: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollToTop: vi.fn(),
    scrollLines: vi.fn(),
    input: vi.fn(),
    focus: vi.fn(),
  }
  return term
}

function mount() {
  const stack = document.createElement('div')
  stack.className = 'terminal-stack'
  const host = document.createElement('div')
  stack.appendChild(host)
  document.body.appendChild(stack)
  const term = liveTerminal()
  const pause = vi.fn()
  const scroll = createHistoryScroll({
    host,
    paneId: 'p1',
    term: term as unknown as OstiaTerminal,
    engine: 'xterm',
    options: () => ({}),
    pause,
  })
  return { stack, host, term, pause, scroll }
}

const wheelUp = () => new WheelEvent('wheel', { deltaY: -100, deltaMode: 0 })
const box = (stack: HTMLElement) => stack.querySelector<HTMLElement>('.history-layer')

beforeEach(() => {
  vi.mocked(window.ostia.pty.historyRead).mockImplementation(async (_pane, from, count) => {
    const end = SEAM + 30
    const start = Math.min(Math.max(0, from), end)
    const stop = Math.min(end, start + count)
    return {
      first: 0,
      end,
      from: start,
      lines: Array.from({ length: Math.max(0, stop - start) }, (_, i) => `hist ${start + i}`),
    }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  panes.length = 0
  scrollListeners.clear()
  vi.mocked(window.ostia.pty.historyRead).mockReset()
  useHistoryViewStore.setState({ open: {} })
})

describe('history scroll', () => {
  it('takes a wheel up at the live top into the lines just above it, with no header', async () => {
    const { stack, scroll, pause } = mount()
    expect(scroll.interceptWheel(wheelUp())).toBe(true)
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    expect(Number(box(stack)?.dataset.top)).toBeLessThan(SEAM)
    expect(Number(box(stack)?.dataset.top)).toBeGreaterThanOrEqual(SEAM - 10)
    expect(pause).toHaveBeenCalledWith(true)
    expect(stack.querySelector('.history-bar, .history-edge, .history-view')).toBeNull()
    expect(stack.querySelector('.history-scrollbar')).not.toBeNull()
    scroll.dispose()
  })

  it('hands back to the live terminal when scrolled down to the seam', async () => {
    const { stack, term, scroll, pause } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    scroll.scrollLines(50)
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('hidden'))
    expect(term.scrollToLine).toHaveBeenCalled()
    expect(pause).toHaveBeenLastCalledWith(false)
    scroll.dispose()
  })

  it('returns to the live bottom and types the key when a key is pressed', async () => {
    const { stack, host, term, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    expect(box(stack)?.style.visibility).toBe('hidden')
    expect(term.scrollToBottom).toHaveBeenCalled()
    scroll.dispose()
  })

  it('lets the wheel through when there is no history above the live screen', async () => {
    vi.mocked(window.ostia.pty.historyRead).mockResolvedValue({
      first: 0,
      end: 30,
      from: 0,
      lines: [],
    })
    const { scroll } = mount()
    expect(scroll.interceptWheel(wheelUp())).toBe(true)
    await vi.waitFor(() => expect(window.ostia.pty.historyRead).toHaveBeenCalled())
    await vi.waitFor(() => expect(scroll.interceptWheel(wheelUp())).toBe(false))
    scroll.dispose()
  })

  it('opens at a block or match target from the history store', async () => {
    const { stack, scroll } = mount()
    useHistoryViewStore.getState().show('p1', { kind: 'line', line: 400 })
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    expect(Number(box(stack)?.dataset.top)).toBe(400 - 3)
    expect(useHistoryViewStore.getState().open.p1).toBeUndefined()
    scroll.dispose()
  })
})
