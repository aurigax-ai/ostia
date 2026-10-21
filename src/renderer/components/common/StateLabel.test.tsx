import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CountBadge } from './CountBadge'
import { StateLabel } from './StateLabel'

afterEach(cleanup)

describe('StateLabel', () => {
  it('shows a dot and its word for a state that needs a look', () => {
    const { container } = render(<StateLabel state="waiting" label="Waiting for input" />)
    expect(screen.getByText('Waiting for input')).toBeInTheDocument()
    expect(container.querySelector('.dot.waiting')).not.toBeNull()
  })

  it('shows nothing for an idle workspace or pane', () => {
    const idle = render(<StateLabel state="idle" label="Idle" />)
    expect(idle.container).toBeEmptyDOMElement()
    const none = render(<StateLabel state="none" label="Idle" />)
    expect(none.container).toBeEmptyDOMElement()
  })
})

describe('CountBadge', () => {
  it('is a labelled pill for unread and plain coloured text for a needs-you count', () => {
    render(
      <>
        <CountBadge variant="unread" count={3} label="3 unread" />
        <CountBadge variant="attn" count={2} />
      </>,
    )
    expect(screen.getByRole('img', { name: '3 unread' })).toHaveTextContent('3')
    expect(screen.getByText('2')).toHaveClass('text-attn-fg')
  })
})
