import '@testing-library/jest-dom/vitest'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryEdge } from './HistoryEdge'

afterEach(() => {
  cleanup()
  vi.mocked(window.ostia.pty.historyRead).mockReset()
})

describe('HistoryEdge', () => {
  it('sizes its icon so it cannot fill the pane', async () => {
    vi.mocked(window.ostia.pty.historyRead).mockResolvedValue({
      first: 0,
      end: 500,
      from: 0,
      lines: [],
    })
    const active = { type: 'normal', viewportY: 0, baseY: 40, length: 80, getLine: () => undefined }
    const term = {
      buffer: { active, normal: active },
      rows: 40,
      onScroll: () => ({ dispose: () => {} }),
    } as unknown as OstiaTerminal
    const host = document.createElement('div')
    const termRef = { current: term }
    const hostRef = { current: host }
    const { container } = render(
      <HistoryEdge paneId="p1" termRef={termRef} hostRef={hostRef} shown />,
    )
    await waitFor(() => expect(container.querySelector('.history-edge')).not.toBeNull())
    expect(container.querySelector('.history-edge > svg')).toHaveClass('size-4', 'shrink-0')
  })
})
