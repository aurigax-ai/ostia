import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusAction, StatusLine } from './StatusLine'

afterEach(cleanup)

describe('StatusLine', () => {
  it('is one 32 px line with the text, its text actions and a close button', () => {
    const onDismiss = vi.fn()
    const onReload = vi.fn()
    render(
      <StatusLine
        tone="warn"
        data-testid="line"
        actions={<StatusAction onClick={onReload}>Reload</StatusAction>}
        onDismiss={onDismiss}
      >
        Changed on disk.
      </StatusLine>,
    )

    const line = screen.getByTestId('line')
    expect(line).toHaveClass('h-8')
    expect(line).toHaveTextContent('Changed on disk.')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('has no close button when nothing can be dismissed', () => {
    render(<StatusLine>Click an element to capture it.</StatusLine>)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('puts the tone on the icon and never on the text', () => {
    const { container } = render(
      <StatusLine tone="error" data-testid="line">
        Could not save.
      </StatusLine>,
    )

    expect(container.querySelector('svg')).toHaveClass('text-attn-fg')
    expect(screen.getByText('Could not save.')).not.toHaveClass('text-attn-fg')
    expect(screen.getByTestId('line')).not.toHaveClass('text-attn-fg')
  })
})
