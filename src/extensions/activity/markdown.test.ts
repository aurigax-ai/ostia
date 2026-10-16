import { describe, expect, it } from 'vitest'
import { type MarkdownNode, renderMarkdown, safeHref } from './markdown'

const ALLOWED_TAGS = new Set([
  'p',
  'em',
  'strong',
  'del',
  'blockquote',
  'li',
  'ul',
  'ol',
  'code',
  'pre',
  'br',
  'hr',
  'a',
  'table',
  'tr',
  'td',
])

function tags(nodes: readonly MarkdownNode[]): string[] {
  return nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node.tag, ...tags(node.children)],
  )
}

function text(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) =>
      typeof node === 'string' ? node : node.tag === 'br' ? '\n' : text(node.children),
    )
    .join('')
}

describe('renderMarkdown', () => {
  it('renders emphasis, code, lists and links the way the agent wrote them', () => {
    const nodes = renderMarkdown(
      'Fixed the **cart** and `roundTo`.\n- one\n- two\n\n[notes](https://example.com/a)',
    )
    expect(tags(nodes)).toEqual(['p', 'strong', 'code', 'ul', 'li', 'p', 'li', 'p', 'p', 'a'])
    const link = JSON.stringify(nodes)
    expect(link).toContain('"href":"https://example.com/a"')
  })

  it('keeps the line breaks of a reply whose blank lines were dropped', () => {
    expect(text(renderMarkdown('first line\nsecond line'))).toBe('first line\nsecond line')
  })

  it('shows raw HTML as text and never as an element', () => {
    const nodes = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="https://evil.example/x.png" onerror="boom()">\n\n<b onclick="x()">bold</b>',
    )
    expect(tags(nodes).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true)
    expect(tags(nodes)).not.toContain('script')
    expect(tags(nodes)).not.toContain('img')
    expect(text(nodes)).toContain('<script>alert(1)</script>')
  })

  it('refuses a remote image: only its alt text remains and nothing can load', () => {
    const nodes = renderMarkdown(
      '![chart](https://evil.example/p.png) and ![](http://evil.example/q.png)',
    )
    expect(tags(nodes)).not.toContain('img')
    expect(JSON.stringify(nodes)).not.toContain('evil.example')
    expect(text(nodes)).toBe('chart and ')
  })

  it('drops a link that is not http, https or mailto and keeps its text', () => {
    const nodes = renderMarkdown(
      '[a](javascript:alert(1)) [b](data:text/html,x) [c](file:///etc/passwd) [d](mailto:me@example.com)',
    )
    expect(JSON.stringify(nodes)).not.toMatch(/javascript|data:|file:/)
    expect(tags(nodes).filter((tag) => tag === 'a')).toEqual(['a'])
    expect(text(nodes)).toBe('a b c d')
  })

  it('gives every element it emits a tag from the allowed set, whatever the input', () => {
    const nodes = renderMarkdown(
      [
        '# Title',
        '> quote',
        '1. one',
        '2. two',
        '| a | b |\n|---|---|\n| 1 | 2 |',
        '```html\n<iframe src="https://evil.example"></iframe>\n```',
        '---',
        '~~gone~~',
        '[ref]: https://evil.example',
        '<style>body{display:none}</style>',
      ].join('\n\n'),
    )
    expect(tags(nodes).every((tag) => ALLOWED_TAGS.has(tag))).toBe(true)
  })
})

describe('safeHref', () => {
  it('accepts http, https and mailto only', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x')
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
    expect(safeHref(undefined)).toBeNull()
  })
})
