import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownPreview, isMarkdownPath } from './MarkdownPreview'

afterEach(cleanup)

describe('MarkdownPreview', () => {
  it('renders headings, GitHub tables and task lists inside a typeset container', () => {
    const { container } = render(
      <MarkdownPreview
        source={'# Databases\n\n| Field | Value |\n|---|---|\n| Port | 5433 |\n\n- [x] done'}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Databases' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '5433' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(container.querySelector('.typeset .typeset-scroll table')).not.toBeNull()
  })

  it('opens links outside Pine', () => {
    render(<MarkdownPreview source="[docs](https://example.com)" />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('shows raw HTML as text instead of running it', () => {
    const { container } = render(<MarkdownPreview source={'<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('isMarkdownPath', () => {
  it('recognises Markdown files only', () => {
    expect(isMarkdownPath('/w/README.md')).toBe(true)
    expect(isMarkdownPath('/w/notes.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('/w/main.ts')).toBe(false)
    expect(isMarkdownPath(undefined)).toBe(false)
  })
})
