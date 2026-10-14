import { describe, expect, it } from 'vitest'
import { fileLinkOf, rehypeFileLinks, wholeFileLink } from './chatLinks'

interface Node {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

function text(value: string): Node {
  return { type: 'text', value }
}

function element(tagName: string, ...children: Node[]): Node {
  return { type: 'element', tagName, properties: {}, children }
}

function linked(tree: Node): Node {
  rehypeFileLinks()(tree)
  return tree
}

function asProps(node: Node): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    props[key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)] = value
  }
  return props
}

describe('rehypeFileLinks', () => {
  it('links a path with a line in an answer’s text to that file and line', () => {
    const root = linked({
      type: 'root',
      children: [element('p', text('The line is in /w/project/notes.txt:3 near the top.'))],
    })
    const [before, link, after] = root.children?.[0].children ?? []
    expect(before).toEqual(text('The line is in '))
    expect(after).toEqual(text(' near the top.'))
    expect(link).toMatchObject({
      type: 'element',
      tagName: 'a',
      children: [text('/w/project/notes.txt:3')],
    })
    expect(fileLinkOf(asProps(link))).toEqual({ path: '/w/project/notes.txt', line: 3 })
  })

  it('leaves paths inside code, code blocks and links as they are', () => {
    const children = (): Node[] => [
      element('p', element('code', text('notes.txt:3')), element('a', text('notes.txt'))),
      element('pre', element('code', text('cat notes.txt'))),
    ]
    expect(linked({ type: 'root', children: children() }).children).toEqual(children())
  })
})

describe('fileLinkOf', () => {
  it('reads nothing from an element without a path', () => {
    expect(fileLinkOf({ href: 'https://example.com' })).toBeNull()
  })
})

describe('wholeFileLink', () => {
  it('takes inline code that is exactly a path with a line and column', () => {
    expect(wholeFileLink(' src/a.ts:12:4 ')).toEqual({ path: 'src/a.ts', line: 12, column: 4 })
    expect(wholeFileLink('npm run build')).toBeNull()
  })
})
