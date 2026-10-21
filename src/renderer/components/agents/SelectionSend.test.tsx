import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSelectionSend } from './SelectionSend'

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
})
