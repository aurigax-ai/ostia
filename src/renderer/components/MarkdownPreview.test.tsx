import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('opens links outside Ostia', () => {
    render(<MarkdownPreview source="[docs](https://example.com)" />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('tags each rendered block with the source lines it came from', () => {
    render(<MarkdownPreview source={'# Title\n\nFirst line\nsecond line\n\n- item'} />)
    const paragraph = screen.getByText(/First line/)
    expect(paragraph).toHaveAttribute('data-line-start', '3')
    expect(paragraph).toHaveAttribute('data-line-end', '4')
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('data-line-start', '1')
  })

  it('reports a selection inside the preview with its text and source lines', () => {
    const onSelectionChange = vi.fn()
    render(
      <MarkdownPreview
        source={'# Title\n\nFirst line\nsecond line\n\n- item'}
        onSelectionChange={onSelectionChange}
      />,
    )
    const heading = screen.getByRole('heading', { name: 'Title' })
    const item = screen.getByText('item')
    const range = document.createRange()
    range.setStart(heading.firstChild as Node, 2)
    range.setEnd(item.firstChild as Node, 4)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    const last = onSelectionChange.mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({ startLine: 1, endLine: 6 })
    expect(last.text).toContain('tle')
    expect(last.text).toContain('First line')
  })

  it('clears the selection when it collapses inside the preview, but not for outside ones', () => {
    const onSelectionChange = vi.fn()
    render(<MarkdownPreview source="Some words" onSelectionChange={onSelectionChange} />)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    const text = screen.getByText('Some words').firstChild as Node
    const select = (node: Node, start: number, end: number): void => {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      document.getSelection()?.removeAllRanges()
      document.getSelection()?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }

    select(text, 0, 4)
    expect(onSelectionChange).toHaveBeenLastCalledWith({ text: 'Some', startLine: 1, endLine: 1 })
    select(document.body, 0, 0)
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    select(text, 2, 2)
    expect(onSelectionChange).toHaveBeenLastCalledWith(null)
    outside.remove()
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
