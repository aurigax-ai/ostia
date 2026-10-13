import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Blocks, RECOMPUTE_MS, StickyHeader } from './Blocks'

const menuRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock('./BlockMenu', () => ({
  BlockMenu: ({ trigger }: { trigger: JSX.Element }) => {
    menuRenders.count++
    return trigger
  },
}))

const info = { blockId: 'b1', command: 'npm run dev', line: 42 }

describe('StickyHeader', () => {
  it('shows the command with a running label while the command runs', () => {
    render(<StickyHeader info={{ ...info, running: true, exitCode: null }} onJump={vi.fn()} />)

    const header = screen.getByRole('button', { name: /Scroll to command: npm run dev/ })
    expect(header).toHaveTextContent('npm run dev')
    expect(header).toHaveTextContent('Running')
    expect(header).not.toHaveClass('attn')
  })

  it('shows the exit code and marks a failed command', () => {
    render(<StickyHeader info={{ ...info, running: false, exitCode: 2 }} onJump={vi.fn()} />)

    const header = screen.getByRole('button', { name: /npm run dev/ })
    expect(header).toHaveTextContent('exit 2')
    expect(header).toHaveClass('attn')
  })

  it('scrolls to the command line when clicked', async () => {
    const onJump = vi.fn()
    render(<StickyHeader info={{ ...info, running: false, exitCode: 0 }} onJump={onJump} />)

    await userEvent.click(screen.getByRole('button', { name: /npm run dev/ }))

    expect(onJump).toHaveBeenCalledWith(42)
  })
})

const PANE = 'pane-blocks'
const ROW_HEIGHT = 17

function terminalHost(): { host: HTMLDivElement; measured: () => number } {
  const stack = document.createElement('div')
  const host = document.createElement('div')
  host.innerHTML = '<div class="xterm-screen"></div>'
  stack.append(host)
  document.body.append(stack)
  let reads = 0
  const screen = host.querySelector('.xterm-screen') as HTMLElement
  screen.getBoundingClientRect = () => {
    reads++
    return { top: 0, height: ROW_HEIGHT * 24 } as DOMRect
  }
  return { host, measured: () => reads }
}

interface FakeTerminal {
  term: Xterm
  render: () => void
  resize: () => void
  scroll: (viewportY: number) => void
  listening: () => number
}

function fakeTerminal(): FakeTerminal {
  const listeners = {
    render: [] as (() => void)[],
    resize: [] as (() => void)[],
    scroll: [] as (() => void)[],
  }
  const on = (list: (() => void)[]) => (fn: () => void) => {
    list.push(fn)
    return { dispose: () => list.splice(list.indexOf(fn), 1) }
  }
  const active = { type: 'normal', viewportY: 0, baseY: 0, cursorY: 6 }
  const term = {
    rows: 24,
    buffer: { active },
    onRender: on(listeners.render),
    onScroll: on(listeners.scroll),
    onResize: on(listeners.resize),
  } as unknown as Xterm
  const fire = (list: (() => void)[]) => () => {
    for (const fn of [...list]) fn()
  }
  const scroll = (viewportY: number): void => {
    active.viewportY = viewportY
    fire(listeners.scroll)()
  }
  const listening = (): number =>
    listeners.render.length + listeners.scroll.length + listeners.resize.length
  return {
    term,
    render: fire(listeners.render),
    resize: fire(listeners.resize),
    scroll,
    listening,
  }
}

function countedAnchor(line: number, reads: { count: number }): LineAnchor {
  return {
    get line() {
      reads.count++
      return line
    },
  }
}

describe('Blocks', () => {
  let init: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    menuRenders.count = 0
    useBlocksStore.setState(init, true)
    document.body.replaceChildren()
  })

  function mount(shown = true) {
    const reads = { count: 0 }
    const s = useBlocksStore.getState()
    s.promptStart(PANE, countedAnchor(0, reads), '/w')
    s.promptEnd(PANE, { line: 0 })
    s.commandStart(PANE, { line: 1 }, 'claude')
    const { host, measured } = terminalHost()
    const terminal = fakeTerminal()
    const props = { paneId: PANE, termRef: { current: terminal.term }, hostRef: { current: host } }
    const view = render(<Blocks {...props} shown={shown} />)
    const show = (next: boolean) => view.rerender(<Blocks {...props} shown={next} />)
    return { ...terminal, measured, view, reads, show }
  }

  it('draws the running block from the measured row height', () => {
    const { view } = mount()
    const gutter = view.container.querySelector('.block-gutter') as HTMLElement
    expect(gutter.style.height).toBe(`${7 * ROW_HEIGHT}px`)
  })

  it('does not measure the layout again on each terminal render', () => {
    const { render: renderFrame, measured } = mount()
    const before = measured()
    act(() => {
      for (let frame = 0; frame < 120; frame++) renderFrame()
    })
    expect(measured()).toBe(before)
  })

  it('measures again when the terminal is resized', () => {
    const { resize, measured } = mount()
    const before = measured()
    act(() => resize())
    expect(measured()).toBe(before + 1)
  })

  it('does no work for a hidden pane and draws the current blocks when shown', () => {
    const { view, render: renderFrame, reads, listening, show } = mount(false)
    expect(listening()).toBe(0)
    expect(view.container.querySelector('.block-gutter')).toBeNull()
    const before = reads.count
    act(() => {
      for (let frame = 0; frame < 60; frame++) renderFrame()
    })
    expect(reads.count).toBe(before)

    show(true)
    const gutter = view.container.querySelector('.block-gutter') as HTMLElement
    expect(gutter.style.height).toBe(`${7 * ROW_HEIGHT}px`)

    show(false)
    expect(listening()).toBe(0)
  })

  it('recomputes at most once per interval while output streams, and once after it stops', () => {
    vi.useFakeTimers()
    const { render: renderFrame, reads } = mount()
    const before = reads.count
    act(() => {
      for (let frame = 0; frame < 6; frame++) {
        renderFrame()
        vi.advanceTimersByTime(RECOMPUTE_MS / 6)
      }
    })
    const streamed = reads.count - before
    expect(streamed).toBeGreaterThan(0)
    expect(streamed).toBeLessThanOrEqual(2)
    const settled = reads.count
    act(() => vi.advanceTimersByTime(RECOMPUTE_MS))
    expect(reads.count).toBeGreaterThan(settled)
  })

  it('moves finished blocks as one layer on scroll without re-rendering them', () => {
    vi.useFakeTimers()
    const { view, scroll } = mount()
    act(() => useBlocksStore.getState().commandEnd(PANE, { line: 4 }, 0))
    const gutter = view.container.querySelector('.block-gutter') as HTMLElement
    const track = view.container.querySelector('.blocks-track') as HTMLElement
    const top = gutter.style.top
    const rendered = menuRenders.count

    act(() => scroll(2))
    act(() => vi.advanceTimersByTime(RECOMPUTE_MS))

    expect(track.style.transform).toBe(`translateY(${-2 * ROW_HEIGHT}px)`)
    expect(view.container.querySelector('.block-gutter')).toBe(gutter)
    expect(gutter.style.top).toBe(top)
    expect(menuRenders.count).toBe(rendered)
  })

  it('does not re-render the running block while its output scrolls the screen', () => {
    vi.useFakeTimers()
    const { view, term, scroll, render: renderFrame } = mount()
    const active = term.buffer.active as { baseY: number; cursorY: number }
    active.cursorY = 23
    act(() => renderFrame())
    act(() => vi.advanceTimersByTime(RECOMPUTE_MS))
    const gutter = view.container.querySelector('.block-gutter') as HTMLElement
    const rendered = menuRenders.count

    act(() => {
      for (let line = 1; line <= 30; line++) {
        active.baseY = line
        scroll(line)
        renderFrame()
        vi.advanceTimersByTime(RECOMPUTE_MS / 3)
      }
    })
    act(() => vi.advanceTimersByTime(RECOMPUTE_MS))

    expect(view.container.querySelector('.block-gutter')).toBe(gutter)
    expect(gutter.style.height).toBe(`${24 * ROW_HEIGHT}px`)
    expect(menuRenders.count).toBe(rendered)
  })
})
