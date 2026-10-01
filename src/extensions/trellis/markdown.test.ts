import { describe, expect, it } from 'vitest'
import {
  MARKDOWN_MAX,
  type RenderElement,
  type RenderNode,
  renderMarkdown,
  safeLink,
} from './markdown'

const ALLOWED_TAGS = new Set([
  'p',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'em',
  'strong',
  'del',
  'code',
  'pre',
  'br',
  'hr',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'table',
  'tbody',
  'tr',
  'td',
  'input',
])
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'class', 'type', 'disabled', 'checked'])

function elements(nodes: RenderNode[]): RenderElement[] {
  return nodes.flatMap((n) => (typeof n === 'string' ? [] : [n, ...elements(n.children)]))
}

function text(nodes: RenderNode[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : text(n.children))).join('')
}

describe('renderMarkdown', () => {
  it('draws headings, emphasis, lists and code as a fixed set of elements', () => {
    const nodes = renderMarkdown(
      '# Goal\n\nUse **WAL** and `fsync`.\n\n1. one\n2. two\n\n```sh\nls\n```',
    )
    expect(nodes.map((n) => (typeof n === 'string' ? n : n.tag))).toEqual(['h2', 'p', 'ol', 'pre'])
    expect(elements(nodes).map((e) => e.tag)).toContain('strong')
    expect(text(nodes)).toContain('ls')
  })

  it('draws task list items as disabled checkboxes', () => {
    const boxes = elements(renderMarkdown('- [ ] parse\n- [x] docs')).filter(
      (e) => e.tag === 'input',
    )
    expect(boxes.map((b) => b.attrs)).toEqual([
      { type: 'checkbox', disabled: '' },
      { type: 'checkbox', disabled: '', checked: '' },
    ])
  })

  it('shows raw HTML as text and never as an element', () => {
    const nodes = renderMarkdown(
      'before\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> and <b onclick="x()">bold</b>',
    )
    const tags = elements(nodes).map((e) => e.tag)
    expect(tags.every((tag) => ALLOWED_TAGS.has(tag))).toBe(true)
    expect(tags).not.toContain('script')
    expect(text(nodes)).toContain('<script>alert(1)</script>')
    expect(text(nodes)).toContain('<img src=x onerror=alert(1)>')
  })

  it('keeps only http, https and mailto links, opened outside the panel', () => {
    const nodes = renderMarkdown(
      '[ok](https://example.com/a) [bad](javascript:alert(1)) [data](data:text/html,x) [rel](/api) <mailto:a@example.com> ![pic](https://example.com/p.png)',
    )
    const links = elements(nodes).filter((e) => e.tag === 'a')
    expect(links.map((l) => l.attrs?.href)).toEqual([
      'https://example.com/a',
      'mailto:a@example.com',
      'https://example.com/p.png',
    ])
    expect(
      links.every((l) => l.attrs?.target === '_blank' && l.attrs.rel === 'noopener noreferrer'),
    ).toBe(true)
    expect(text(nodes)).toContain('bad')
    expect(elements(nodes).some((e) => e.tag === 'img')).toBe(false)
  })

  it('uses only known tags and attributes for the captured card and entry bodies', () => {
    const all = elements(
      renderMarkdown(
        '## Goal\n\n- [ ] a\n\n<script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> q\n\n---\n\n~~x~~ *y*\n\n[this](javascript:alert(1))',
      ),
    )
    for (const e of all) {
      expect(ALLOWED_TAGS.has(e.tag), e.tag).toBe(true)
      for (const name of Object.keys(e.attrs ?? {}))
        expect(ALLOWED_ATTRS.has(name), name).toBe(true)
    }
  })

  it('shows an oversized body as clipped plain text', () => {
    const nodes = renderMarkdown('x'.repeat(MARKDOWN_MAX + 10))
    expect(nodes).toHaveLength(1)
    expect((nodes[0] as RenderElement).tag).toBe('pre')
    expect(text(nodes)).toHaveLength(MARKDOWN_MAX)
  })

  it('refuses links that are not absolute http, https or mailto', () => {
    expect(safeLink('https://example.com')).toBe('https://example.com/')
    expect(safeLink('JAVASCRIPT:alert(1)')).toBeNull()
    expect(safeLink('file:///etc/passwd')).toBeNull()
    expect(safeLink('//example.com')).toBeNull()
    expect(safeLink(undefined)).toBeNull()
  })
})
