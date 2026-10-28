import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import type { OstiaTerminal } from './ostiaTerminal'
import { registerInputEditor } from './terminalHandles'

interface FakePane {
  term: Record<string, unknown>
  el: HTMLElement
  dispose: () => void
  top: number
  lines: string[]
  scrolledBy: number
  selected: string
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
      selected: '',
      term: {},
    }
    pane.term = {
      cols: 80,
      rows: 10,
      reset: () => {
        pane.lines = []
      },
      write: (data: string, done?: () => void) => {
        pane.lines = data.replace('\x1bc', '').split('\r\n')
        done?.()
      },
      resize: () => {},
      select: () => {},
      hasSelection: () => pane.selected !== '',
      getSelection: () => pane.selected,
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

const pasteSpy = vi.fn()

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
    paste: pasteSpy,
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollToTop: vi.fn(),
    scrollLines: vi.fn(),
    input: vi.fn(),
    focus: vi.fn(),
  }
  return term
}

function mount(shown = true) {
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
    shown: () => shown,
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

  it('moves down through history in order and hands back at the seam', async () => {
    const { stack, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    scroll.scrollLines(-30)
    const tops: number[] = [Number(box(stack)?.dataset.top)]
    for (let i = 0; i < 20 && box(stack)?.style.visibility === 'visible'; i++) {
      scroll.scrollLines(7)
      await vi.waitFor(() =>
        expect(Number(box(stack)?.dataset.top)).toBeGreaterThan(tops.at(-1) ?? 0),
      )
      if (box(stack)?.style.visibility === 'visible') tops.push(Number(box(stack)?.dataset.top))
    }
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('hidden'))
    expect(tops.length).toBeGreaterThan(3)
    expect(tops).toEqual([...tops].sort((a, b) => a - b))
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

  it('returns to the live bottom when text is pasted or typed into the live terminal', async () => {
    const { stack, term, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    ;(term as unknown as { paste: (data: string) => void }).paste('\x1b[200~text\x1b[201~')
    expect(box(stack)?.style.visibility).toBe('hidden')
    expect(pasteSpy).toHaveBeenCalledWith('\x1b[200~text\x1b[201~')
    expect(term.scrollToBottom).toHaveBeenCalled()
    scroll.dispose()
  })

  it('moves focus from the history layer to the live terminal or its input editor', async () => {
    const { stack, term, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    panes[0]?.el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await vi.waitFor(() => expect(term.focus).toHaveBeenCalled())
    const focus = vi.fn()
    const unregister = registerInputEditor('p1', {
      insert: vi.fn(),
      type: vi.fn(),
      focus,
      take: vi.fn(),
    })
    panes[0]?.el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await vi.waitFor(() => expect(focus).toHaveBeenCalled())
    unregister()
    scroll.dispose()
  })

  it('copies a selection made in the layer and keeps the layer, but sends Ctrl+C to the shell without one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    useSettingsStore.setState((state) => ({
      terminal: { ...state.terminal, clipboardKeys: 'smart' },
    }))
    const { stack, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    const pane = panes[1] ?? panes[0]
    const visiblePane = panes.find((p) => p.el.style.visibility === '') ?? pane
    if (visiblePane) visiblePane.selected = 'picked'
    const ctrlC = () =>
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
    const copy = ctrlC()
    stack.dispatchEvent(copy)
    expect(writeText).toHaveBeenCalledWith('picked')
    expect(copy.defaultPrevented).toBe(true)
    expect(box(stack)?.style.visibility).toBe('visible')
    if (visiblePane) visiblePane.selected = ''
    const interrupt = ctrlC()
    stack.dispatchEvent(interrupt)
    expect(interrupt.defaultPrevented).toBe(false)
    expect(box(stack)?.style.visibility).toBe('hidden')
    scroll.dispose()
  })

  it('leaves history when an IME composition starts', async () => {
    const { stack, host, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    host.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    expect(box(stack)?.style.visibility).toBe('hidden')
    scroll.dispose()
  })

  it('never covers the alternate screen, even when it starts while history is loading', async () => {
    const { stack, term, pause, scroll } = mount()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const serve = vi.mocked(window.ostia.pty.historyRead).getMockImplementation()
    vi.mocked(window.ostia.pty.historyRead).mockImplementation(async (...args) => {
      await gate
      return serve?.(...args) ?? null
    })
    scroll.interceptWheel(wheelUp())
    ;(term.buffer.active as { type: string }).type = 'alternate'
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(box(stack)?.style.visibility).not.toBe('visible')
    expect(pause).not.toHaveBeenCalledWith(true)
    useHistoryViewStore.getState().show('p1', { kind: 'line', line: 400 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(box(stack)?.style.visibility).not.toBe('visible')
    scroll.scrollToTop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(box(stack)?.style.visibility).not.toBe('visible')
    scroll.dispose()
  })

  it('stays on the live terminal when a key is pressed while a history load is still running', async () => {
    const { stack, host, term, pause, scroll } = mount()
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const serve = vi.mocked(window.ostia.pty.historyRead).getMockImplementation()
    vi.mocked(window.ostia.pty.historyRead).mockImplementation(async (...args) => {
      await gate
      return serve?.(...args) ?? null
    })
    scroll.scrollToTop()
    scroll.scrollLines(-3)
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(box(stack)?.style.visibility).toBe('hidden')
    pause.mockClear()
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(box(stack)?.style.visibility).toBe('hidden')
    expect(pause).not.toHaveBeenCalledWith(true)
    expect(term.scrollToBottom).toHaveBeenCalled()
    expect(term.scrollToTop).not.toHaveBeenCalled()
    scroll.dispose()
  })

  it('stays on the live terminal when input arrives during the first history load', async () => {
    const { stack, term, pause, scroll } = mount()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const serve = vi.mocked(window.ostia.pty.historyRead).getMockImplementation()
    vi.mocked(window.ostia.pty.historyRead).mockImplementation(async (...args) => {
      await gate
      return serve?.(...args) ?? null
    })
    scroll.scrollToTop()
    term.input('x', true)
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(box(stack)?.style.visibility).not.toBe('visible')
    expect(pause).not.toHaveBeenCalledWith(true)
    expect(term.scrollToTop).not.toHaveBeenCalled()
    scroll.dispose()
  })

  it('does not resume drawing a pane that is hidden when history closes', async () => {
    const { stack, pause, scroll } = mount(false)
    scroll.interceptWheel(wheelUp())
    await vi.waitFor(() => expect(box(stack)?.style.visibility).toBe('visible'))
    scroll.scrollToBottom()
    expect(box(stack)?.style.visibility).toBe('hidden')
    expect(pause).not.toHaveBeenCalledWith(false)
    scroll.dispose()
  })
})
