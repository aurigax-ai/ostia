import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TextLink } from './TextLink'

describe('TextLink', () => {
  it('is muted grey with full colour on hover and focus instead of brand orange', () => {
    render(<TextLink>Edit prompt</TextLink>)
    const link = screen.getByRole('button', { name: 'Edit prompt' })
    expect(link).toHaveClass('text-fg-muted', 'hover:text-fg', 'focus-visible:text-fg')
    expect(link).toHaveClass('hover:underline')
    expect(link).not.toHaveClass('text-primary')
  })

  it('keeps a caller colour over the muted default', () => {
    render(<TextLink className="text-fg text-ui-sm">Workspace</TextLink>)
    const link = screen.getByRole('button', { name: 'Workspace' })
    expect(link).toHaveClass('text-fg', 'text-ui-sm')
    expect(link).not.toHaveClass('text-fg-muted')
  })
})
