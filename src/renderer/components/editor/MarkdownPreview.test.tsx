import '@testing-library/jest-dom/vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview, isMarkdownPath } from './MarkdownPreview'

const released = vi.hoisted(() => vi.fn())
const drawn = vi.hoisted(() => vi.fn<(code: string, dark: boolean) => Promise<string>>())
vi.mock('@/lib/files/mermaidImage', () => ({
  mermaidSvg: drawn,
  svgImageUrl: () => 'blob:diagram-1',
  releaseImageUrl: released,
}))

const initialSettings = useSettingsStore.getState()

afterEach(() => {
  cleanup()
  useSettingsStore.setState(initialSettings, true)
})

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

describe('MarkdownPreview with untrusted content', () => {
  it('renders no script, no handler and no raw image from HTML in the text', () => {
    const { container } = render(
      <MarkdownPreview
        source={
          '<script>window.__ran = true</script>\n\n<img src="http://127.0.0.1:1/a.png" onerror="window.__ran = true">\n\n<iframe src="http://127.0.0.1:1/"></iframe>\n\ntext'
        }
      />,
    )
    expect(container.querySelector('script, iframe, img, [onerror]')).toBeNull()
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined()
    expect(container.textContent).toContain('<script>window.__ran = true</script>')
  })

  it('never turns a javascript: link into a link that runs', () => {
    const { container } = render(<MarkdownPreview source="[x](javascript:alert(1))" />)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.every((href) => !href.toLowerCase().startsWith('javascript:'))).toBe(true)
  })
})

describe('MarkdownPreview diagrams', () => {
  it('draws a mermaid block as an image, never as markup in the page', async () => {
    drawn.mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__ran = 1</script><g id="flow"/></svg>',
    )
    const { container } = render(
      <MarkdownPreview
        source={'# Plan\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nconst a = 1\n```\n'}
      />,
    )
    const image = await screen.findByTestId('mermaid-diagram')
    expect(image.tagName).toBe('IMG')
    expect(image.getAttribute('src')).toBe('blob:diagram-1')
    expect(drawn).toHaveBeenCalledWith('graph TD\n  A-->B', expect.any(Boolean))
    expect(container.querySelector('svg, script, #flow')).toBeNull()
    expect(container.querySelectorAll('pre')).toHaveLength(1)
    expect(container.querySelector('pre')?.textContent).toContain('const a = 1')
    cleanup()
    expect(released).toHaveBeenCalledWith('blob:diagram-1')
  })

  it('shows the source and the reason when a diagram cannot be drawn', async () => {
    drawn.mockRejectedValue(new Error('Parse error on line 2'))
    const { container } = render(<MarkdownPreview source={'```mermaid\ngraph TD\n  A--\n```\n'} />)
    expect(await screen.findByTestId('mermaid-problem')).toHaveTextContent('Parse error on line 2')
    expect(container.querySelector('pre')?.textContent).toContain('graph TD')
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
  })
})

describe('MarkdownPreview find', () => {
  const SOURCE = '# Needle\n\nOne needle, then another needle.\n'

  it('opens with the find key, counts matches and steps through them', async () => {
    render(<MarkdownPreview source={SOURCE} />)
    const preview = document.querySelector('.markdown-preview') as HTMLElement
    const user = userEvent.setup()

    fireEvent.keyDown(preview, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    const box = screen.getByRole('textbox', { name: 'Find in preview' })
    expect(box).toHaveFocus()

    await user.type(box, 'needle')
    expect(screen.getByText('1/3')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.getByText('2/3')).toBeInTheDocument()
    await user.keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}')
    expect(screen.getByText('3/3')).toBeInTheDocument()

    await user.clear(box)
    await user.type(box, 'absent')
    expect(screen.getByText('No results')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Find in preview' })).not.toBeInTheDocument()
    expect(preview).toHaveFocus()
  })

  it('steps with F3 and Shift+F3 in the find bar', async () => {
    render(<MarkdownPreview source={SOURCE} />)
    const preview = document.querySelector('.markdown-preview') as HTMLElement
    const user = userEvent.setup()
    fireEvent.keyDown(preview, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    await user.type(screen.getByRole('textbox', { name: 'Find in preview' }), 'needle')
    await user.keyboard('{F3}{F3}')
    expect(screen.getByText('3/3')).toBeInTheDocument()
    await user.keyboard('{Shift>}{F3}{/Shift}')
    expect(screen.getByText('2/3')).toBeInTheDocument()
  })

  it('steps with the find-next chord from the preview, and opens the bar when it is closed', async () => {
    useSettingsStore.setState({ keybindings: { 'find.next': 'Ctrl+Alt+G' } })
    render(<MarkdownPreview source={SOURCE} />)
    const preview = document.querySelector('.markdown-preview') as HTMLElement
    const findNext = { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true }
    fireEvent.keyDown(preview, findNext)
    const box = screen.getByRole('textbox', { name: 'Find in preview' })
    await userEvent.setup().type(box, 'needle')
    fireEvent.keyDown(box, findNext)
    expect(screen.getByText('2/3')).toBeInTheDocument()
    fireEvent.keyDown(preview, findNext)
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('also opens with Ctrl+F', () => {
    render(<MarkdownPreview source={SOURCE} />)
    const preview = document.querySelector('.markdown-preview') as HTMLElement
    fireEvent.keyDown(preview, { key: 'f', code: 'KeyF', ctrlKey: true })
    expect(screen.getByRole('textbox', { name: 'Find in preview' })).toBeInTheDocument()
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
