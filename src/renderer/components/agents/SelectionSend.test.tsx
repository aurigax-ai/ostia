import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { copyPaneSelection } from '@/lib/agents/selectionCopiers'
import { type SelectionSend, useSelectionSend } from './SelectionSend'

function Host({ overlay, hint }: { overlay?: boolean; hint: string }): JSX.Element {
  const selectionSend = useSelectionSend('w1', 'p1', overlay)
  const { notify } = selectionSend
  useEffect(() => notify(hint), [notify, hint])
  return <div>{selectionSend.status}</div>
}

afterEach(cleanup)

describe('useSelectionSend', () => {
  it('keeps a hint transient and muted, in the flow unless asked to overlay', () => {
    const { rerender } = render(<Host hint="Select something first." />)
    const line = screen.getByRole('status')
    expect(line).toHaveTextContent('Select something first.')
    expect(line.parentElement).not.toHaveClass('absolute')
    expect(line.querySelector('svg')).not.toHaveClass('text-attn-fg')

    rerender(<Host overlay hint="Select something else." />)
    act(() => {})
    expect(screen.getByRole('status').parentElement).toHaveClass('absolute')
  })

  it('answers Ctrl+C for its pane while a bar is open, and stops when it closes', async () => {
    let open: SelectionSend['open'] = () => {}
    function Panel(): JSX.Element {
      const selectionSend = useSelectionSend('w1', 'p1')
      open = selectionSend.open
      return (
        <TooltipProvider>
          <div className="relative">
            {selectionSend.panel}
            {selectionSend.status}
          </div>
        </TooltipProvider>
      )
    }
    render(<Panel />)
    expect(copyPaneSelection('p1')).toBe(false)
    act(() => {
      open({
        kind: 'text',
        file: '/w/a.ts',
        view: 'source',
        range: { startLine: 1, endLine: 1 },
        text: 'selected text',
      })
    })
    await screen.findByRole('toolbar', { name: 'Selection actions' })
    await act(async () => {
      expect(copyPaneSelection('p1')).toBe(true)
    })
    expect(window.ostia.clipboard.writeCapture).toHaveBeenCalledWith({ text: 'selected text' })
    expect(await screen.findByText('Copied the selection.')).toBeInTheDocument()
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(copyPaneSelection('p1')).toBe(false)
  })

  it('has nothing to copy for an image capture without its pixels', async () => {
    let open: SelectionSend['open'] = () => {}
    function Panel(): JSX.Element {
      const selectionSend = useSelectionSend('w1', 'p1')
      open = selectionSend.open
      return <TooltipProvider>{selectionSend.panel}</TooltipProvider>
    }
    render(<Panel />)
    act(() => {
      open({ kind: 'image', file: '/w/a.png', imageWidth: 4, imageHeight: 4, region: null })
    })
    await screen.findByRole('toolbar', { name: 'Selection actions' })
    expect(copyPaneSelection('p1')).toBe(false)
    expect(vi.mocked(window.ostia.clipboard.writeCapture)).not.toHaveBeenCalled()
  })
})
