import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FindStepRef } from '@/components/common/FindBar'
import type { TerminalSearch as SearchAddon } from '@/lib/terminal/ostiaTerminal'
import { TerminalFind } from './TerminalFind'

afterEach(cleanup)

function fakeSearch() {
  return {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
  }
}

describe('TerminalFind', () => {
  it('steps with Enter, F3 and the step ref, backwards with Shift', async () => {
    const search = fakeSearch()
    const stepRef: FindStepRef = { current: null }
    const onClose = vi.fn()
    render(
      <TerminalFind
        paneId="p1"
        liveLines={() => 0}
        onShowEarlier={vi.fn()}
        search={search as unknown as SearchAddon}
        options={{}}
        stepRef={stepRef}
        onClose={onClose}
      />,
    )
    const box = screen.getByRole('textbox', { name: 'Find in terminal' })
    expect(box).toHaveFocus()
    const user = userEvent.setup()
    await user.type(box, 'ab')
    search.findNext.mockClear()
    await user.keyboard('{Enter}{F3}')
    expect(search.findNext).toHaveBeenCalledTimes(2)
    await user.keyboard('{Shift>}{F3}{/Shift}{Shift>}{Enter}{/Shift}')
    expect(search.findPrevious).toHaveBeenCalledTimes(2)
    act(() => stepRef.current?.(1))
    expect(search.findNext).toHaveBeenLastCalledWith('ab', {})
    expect(search.findNext).toHaveBeenCalledTimes(3)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets go of the step ref when it closes', () => {
    const stepRef: FindStepRef = { current: null }
    const { unmount } = render(
      <TerminalFind
        paneId="p1"
        liveLines={() => 0}
        onShowEarlier={vi.fn()}
        search={fakeSearch() as unknown as SearchAddon}
        options={{}}
        stepRef={stepRef}
        onClose={() => {}}
      />,
    )
    expect(stepRef.current).toBeTypeOf('function')
    unmount()
    expect(stepRef.current).toBeNull()
  })

  it('offers matches in earlier output and opens the newest one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const matches = [
      { line: 3, start: 0, end: 2 },
      { line: 9, start: 4, end: 6 },
    ]
    const historySearch = vi.mocked(window.ostia.pty.historySearch)
    historySearch.mockResolvedValue({ count: 240, matches })
    const onShowEarlier = vi.fn()
    render(
      <TerminalFind
        paneId="p1"
        liveLines={() => 42}
        onShowEarlier={onShowEarlier}
        search={fakeSearch() as unknown as SearchAddon}
        options={{}}
        onClose={() => {}}
      />,
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.type(screen.getByRole('textbox', { name: 'Find in terminal' }), 'ab')
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(historySearch).toHaveBeenLastCalledWith('p1', 'ab', {}, 42)
    await user.click(await screen.findByRole('button', { name: '240 earlier' }))
    expect(onShowEarlier).toHaveBeenCalledWith({ query: 'ab', options: {}, matches, index: 1 })
    vi.useRealTimers()
  })
})
