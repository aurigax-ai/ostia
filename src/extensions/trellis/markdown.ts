import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export interface RenderElement {
  tag: string
  attrs?: Record<string, string>
  children: RenderNode[]
}

export type RenderNode = string | RenderElement

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  depth?: number
  ordered?: boolean
  checked?: boolean | null
  url?: string
  alt?: string | null
  lang?: string | null
}

export const MARKDOWN_MAX = 256 * 1024
const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6', 'h6']
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function safeLink(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function el(tag: string, children: RenderNode[], attrs?: Record<string, string>): RenderElement {
  return attrs ? { tag, attrs, children } : { tag, children }
}

function kids(node: MdNode): RenderNode[] {
  return (node.children ?? []).flatMap(render)
}

function link(url: string | undefined, children: RenderNode[]): RenderNode[] {
  const href = safeLink(url)
  if (!href) return children
  return [el('a', children, { href, target: '_blank', rel: 'noopener noreferrer' })]
}

function listItem(node: MdNode): RenderNode[] {
  const children = kids(node)
  if (typeof node.checked !== 'boolean') return [el('li', children)]
  const box: Record<string, string> = { type: 'checkbox', disabled: '' }
  if (node.checked) box.checked = ''
  return [el('li', [el('input', [], box), ...children], { class: 'task' })]
}

function render(node: MdNode): RenderNode[] {
  switch (node.type) {
    case 'text':
    case 'html':
      return [node.value ?? '']
    case 'paragraph':
      return [el('p', kids(node))]
    case 'heading':
      return [el(HEADING_TAGS[(node.depth ?? 1) - 1] ?? 'h6', kids(node))]
    case 'emphasis':
      return [el('em', kids(node))]
    case 'strong':
      return [el('strong', kids(node))]
    case 'delete':
      return [el('del', kids(node))]
    case 'inlineCode':
      return [el('code', [node.value ?? ''])]
    case 'code':
      return [el('pre', [el('code', [node.value ?? ''])])]
    case 'break':
      return [el('br', [])]
    case 'thematicBreak':
      return [el('hr', [])]
    case 'blockquote':
      return [el('blockquote', kids(node))]
    case 'list':
      return [el(node.ordered ? 'ol' : 'ul', kids(node))]
    case 'listItem':
      return listItem(node)
    case 'link':
      return link(node.url, kids(node))
    case 'image':
      return link(node.url, [node.alt || node.url || ''])
    case 'table':
      return [el('table', [el('tbody', kids(node))])]
    case 'tableRow':
      return [el('tr', kids(node))]
    case 'tableCell':
      return [el('td', kids(node))]
    default:
      return node.children ? kids(node) : node.value ? [node.value] : []
  }
}

export function renderMarkdown(source: string): RenderNode[] {
  if (source.length > MARKDOWN_MAX) return [el('pre', [source.slice(0, MARKDOWN_MAX)])]
  try {
    const tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MdNode
    return kids(tree)
  } catch {
    return [el('pre', [source])]
  }
}
