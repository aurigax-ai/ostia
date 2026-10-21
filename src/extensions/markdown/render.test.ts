import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MermaidDiagram } from './diagram'
import { markdownElement } from './render'

function html(source: string, diagram = vi.fn()): string {
  diagram.mockReturnValue(null)
  return renderToStaticMarkup(markdownElement(source, { diagram, onLink: () => {} }))
}

describe('markdownElement', () => {
  it('renders headings, GitHub tables and task lists, with a scrolling wrapper for tables', () => {
    const out = html('# Databases\n\n| Field | Value |\n|---|---|\n| Port | 5433 |\n\n- [x] done')
    expect(out).toContain('<h1')
    expect(out).toMatch(/<div class="typeset-scroll"><table[^>]*><thead/)
    expect(out).toMatch(/<td[^>]*>5433<\/td>/)
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
  })

  it('tags each block with the source lines it came from', () => {
    const out = html('# Title\n\nFirst line\nsecond line\n\n- item')
    expect(out).toMatch(/<h1 data-line-start="1" data-line-end="1">Title<\/h1>/)
    expect(out).toMatch(/<p data-line-start="3" data-line-end="4">First line\nsecond line<\/p>/)
  })

  it('shows raw HTML as text and renders no script, frame, handler or raw image', () => {
    const out = html(
      '<script>window.__ran = true</script>\n\n<img src="http://127.0.0.1:1/a.png" onerror="window.__ran = true">\n\n<iframe src="http://127.0.0.1:1/"></iframe>\n\ntext',
    )
    expect(out).not.toMatch(/<(script|iframe|img)\b/i)
    expect(out).not.toMatch(/<[^>]*\son[a-z]+=/i)
    expect(out).toContain('&lt;script&gt;window.__ran = true&lt;/script&gt;')
  })

  it('never keeps a javascript: link, and shows no image at all', () => {
    const out = html(
      '[x](javascript:alert(1)) [y](data:text/html,hi) ![alt](pic.png) ![b](https://e.test/a.png)',
    )
    expect(out).not.toMatch(/href="(javascript|data):/i)
    expect(out).not.toContain('<img')
  })

  it('keeps http, mailto and relative links', () => {
    const out = html('[a](https://example.com) [b](mailto:x@y.test) [c](docs/other.md) [d](#top)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('href="mailto:x@y.test"')
    expect(out).toContain('href="docs/other.md"')
    expect(out).toContain('href="#top"')
  })

  it('hands a mermaid block to the diagram and keeps other code blocks', () => {
    const diagram = vi.fn()
    const out = html('```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nconst a = 1\n```\n', diagram)
    expect(diagram).toHaveBeenCalledTimes(1)
    expect(diagram).toHaveBeenCalledWith('graph TD\n  A-->B', {
      'data-line-start': 1,
      'data-line-end': 4,
    })
    expect(out).toContain('const a = 1')
    expect(out).not.toContain('graph TD')
  })

  it('shows the diagram source while it is drawn or when it cannot be', () => {
    const out = renderToStaticMarkup(
      createElement(MermaidDiagram, {
        code: 'graph TD\n  A--',
        labels: { alt: 'Diagram', problem: 'Could not draw:', tooLarge: 'too large' },
        lines: { 'data-line-start': 1 },
      }),
    )
    expect(out).toContain('<pre><code>graph TD\n  A--</code></pre>')
    expect(out).toContain('data-line-start="1"')
  })
})
