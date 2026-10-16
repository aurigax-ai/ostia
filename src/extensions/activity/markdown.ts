import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

interface MarkdownElement {
  tag: string
  href?: string
  children: MarkdownNode[]
}

export type MarkdownNode = string | MarkdownElement

interface Mdast {
  type: string
  value?: string
  url?: string
  alt?: string | null
  ordered?: boolean
  children?: Mdast[]
}

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

const WRAPPERS: Record<string, string> = {
  paragraph: 'p',
  emphasis: 'em',
  strong: 'strong',
  delete: 'del',
  blockquote: 'blockquote',
  listItem: 'li',
  table: 'table',
  tableRow: 'tr',
  tableCell: 'td',
}

export function safeHref(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function lines(text: string): MarkdownNode[] {
  return text
    .split('\n')
    .flatMap((line, i) => (i === 0 ? [line] : [{ tag: 'br', children: [] }, line]))
}

function children(node: Mdast): MarkdownNode[] {
  return (node.children ?? []).flatMap(convert)
}

function convert(node: Mdast): MarkdownNode[] {
  const wrapper = WRAPPERS[node.type]
  if (wrapper) return [{ tag: wrapper, children: children(node) }]
  switch (node.type) {
    case 'text':
    case 'html':
      return lines(node.value ?? '')
    case 'heading':
      return [{ tag: 'p', children: [{ tag: 'strong', children: children(node) }] }]
    case 'inlineCode':
      return [{ tag: 'code', children: [node.value ?? ''] }]
    case 'code':
      return [{ tag: 'pre', children: [{ tag: 'code', children: [node.value ?? ''] }] }]
    case 'break':
      return [{ tag: 'br', children: [] }]
    case 'thematicBreak':
      return [{ tag: 'hr', children: [] }]
    case 'list':
      return [{ tag: node.ordered ? 'ol' : 'ul', children: children(node) }]
    case 'link': {
      const href = safeHref(node.url)
      return href ? [{ tag: 'a', href, children: children(node) }] : children(node)
    }
    case 'image':
      return [node.alt || '']
    default:
      return node.children ? children(node) : node.value ? [node.value] : []
  }
}

export function renderMarkdown(source: string): MarkdownNode[] {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Mdast
  return children(tree)
}
