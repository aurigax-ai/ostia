import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const terms: FakeXterm[] = []

class FakeXterm {
  options: Record<string, unknown>
  rows = 10
  cols = 40
  lines: string[] = []
  scrolledTo: number | null = null
  selected: [number, number, number] | null = null
  unicode = { activeVersion: '' }
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null
  scrollListener: (() => void) | null = null
  constructor(options: Record<string, unknown>) {
    this.options = options
    terms.push(this)
  }
  get buffer() {
    const lines = this.lines
    return {
      active: {
        viewportY: this.scrolledTo ?? 0,
        baseY: Math.max(0, lines.length - this.rows),
        length: lines.length,
        getLine: (y: number) =>
          y < lines.length ? { isWrapped: false, translateToString: () => lines[y] } : undefined,
      },
    }
  }
  loadAddon(): void {}
  open(): void {}
  focus(): void {}
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler
  }
  attachCustomWheelEventHandler(): void {}
  onScroll(listener: () => void) {
    this.scrollListener = listener
    return { dispose: () => {} }
  }
  reset(): void {
    this.lines = []
  }
  write(data: string, done?: () => void): void {
    this.lines = data.split('\r\n')
    done?.()
  }
  scrollToLine(line: number): void {
    this.scrolledTo = line
  }
  select(col: number, row: number, length: number): void {
    this.selected = [col, row, length]
  }
  hasSelection(): boolean {
    return false
  }
  getSelection(): string {
    return ''
  }
  dispose(): void {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXterm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))

const { HistoryView } = await import('./HistoryView')

const settle = (check: () => void) => act(() => vi.waitFor(check))

const numbered = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`)

function serveHistory(first: number, end: number) {
  vi.mocked(window.ostia.pty.historyRead).mockImplementation(async (_pane, from, count) => {
    const start = Math.max(first, from)
    const stop = Math.min(end, start + count)
    return { first, end, from: start, lines: numbered(start, Math.max(0, stop - start)) }
  })
}

afterEach(() => {
  cleanup()
  terms.length = 0
  vi.mocked(window.ostia.pty.historyRead).mockReset()
})

describe('HistoryView', () => {
  it('opens just above what the live terminal shows', async () => {
    serveHistory(0, 50_000)
    render(
      <HistoryView paneId="p1" target={{ kind: 'aboveLive', liveLines: 30 }} onClose={vi.fn()} />,
    )
    const term = terms[0]
    await settle(() => expect(term.scrolledTo).not.toBeNull())
    const top = 50_000 - 30 - term.rows
    expect(term.lines[term.scrolledTo ?? 0]).toBe(`line ${top}`)
    expect(screen.getByText(`Line ${(top + 1).toLocaleString()} of 50,000`)).toBeInTheDocument()
  })

  it('selects a search match and steps to an older one', async () => {
    serveHistory(0, 10_000)
    const find = {
      query: 'needle',
      options: {},
      matches: [
        { line: 100, start: 5, end: 11 },
        { line: 9000, start: 2, end: 8 },
      ],
      index: 1,
    }
    const { rerender } = render(
      <HistoryView paneId="p1" target={{ kind: 'match', find }} onClose={vi.fn()} />,
    )
    const term = terms[0]
    await settle(() => expect(term.selected).toEqual([2, expect.any(Number), 6]))
    expect(term.lines[term.selected?.[1] ?? 0]).toBe('line 9000')
    rerender(
      <HistoryView
        paneId="p1"
        target={{ kind: 'match', find: { ...find, index: 0 } }}
        onClose={vi.fn()}
      />,
    )
    await settle(() => expect(term.lines[term.selected?.[1] ?? 0]).toBe('line 100'))
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('loads the previous page when scrolled near its top', async () => {
    serveHistory(0, 50_000)
    render(<HistoryView paneId="p1" target={{ kind: 'line', line: 20_000 }} onClose={vi.fn()} />)
    const term = terms[0]
    await settle(() => expect(term.scrolledTo).not.toBeNull())
    const before = term.lines[0]
    term.scrolledTo = 0
    await act(async () => term.scrollListener?.())
    await settle(() => expect(term.lines[0]).not.toBe(before))
    expect(term.lines[term.scrolledTo ?? 0]).toBe(before)
  })

  it('goes back to live on Escape, on a typed key and on its button', async () => {
    serveHistory(0, 100)
    const onClose = vi.fn()
    render(<HistoryView paneId="p1" target={{ kind: 'line', line: 0 }} onClose={onClose} />)
    const term = terms[0]
    const key = (k: string) =>
      term.keyHandler?.(new KeyboardEvent('keydown', { key: k, cancelable: true }))
    key('Escape')
    key('a')
    key('Shift')
    expect(onClose).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})
