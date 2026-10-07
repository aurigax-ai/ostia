import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Terminal as Xterm } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useBlocksStore } from '../stores/blocksStore'
import { Blocks, StickyHeader } from './Blocks'

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

function fakeTerminal(): { term: Xterm; render: () => void; resize: () => void } {
  const listeners = { render: [] as (() => void)[], resize: [] as (() => void)[] }
  const on = (list: (() => void)[]) => (fn: () => void) => {
    list.push(fn)
    return { dispose: () => list.splice(list.indexOf(fn), 1) }
  }
  const term = {
    rows: 24,
    buffer: { active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 6 } },
    onRender: on(listeners.render),
    onScroll: on([]),
    onResize: on(listeners.resize),
  } as unknown as Xterm
  const fire = (list: (() => void)[]) => () => {
    for (const fn of [...list]) fn()
  }
  return { term, render: fire(listeners.render), resize: fire(listeners.resize) }
}

describe('Blocks', () => {
  let init: ReturnType<typeof useBlocksStore.getState>

  beforeAll(() => {
    init = useBlocksStore.getState()
  })

  afterEach(() => {
    cleanup()
    useBlocksStore.setState(init, true)
    document.body.replaceChildren()
  })

  function mount() {
    const s = useBlocksStore.getState()
    s.promptStart(PANE, { line: 0 }, '/w')
    s.promptEnd(PANE, { line: 0 })
    s.commandStart(PANE, { line: 1 }, 'claude')
    const { host, measured } = terminalHost()
    const terminal = fakeTerminal()
    const view = render(
      <Blocks paneId={PANE} termRef={{ current: terminal.term }} hostRef={{ current: host }} />,
    )
    return { ...terminal, measured, view }
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
})
