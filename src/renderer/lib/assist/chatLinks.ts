import { findFileLinks } from '@shared/fileLinks'

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIP_TAGS = new Set(['a', 'code', 'pre'])

export const FILE_LINK_PATH = 'data-ostia-path'
export const FILE_LINK_LINE = 'data-ostia-line'
export const FILE_LINK_COLUMN = 'data-ostia-column'

function linkElement(text: string, path: string, line?: number, column?: number): HastNode {
  const properties: Record<string, unknown> = { dataOstiaPath: path }
  if (line) properties.dataOstiaLine = String(line)
  if (column) properties.dataOstiaColumn = String(column)
  return { type: 'element', tagName: 'a', properties, children: [{ type: 'text', value: text }] }
}

function splitText(value: string): HastNode[] | null {
  const matches = findFileLinks(value)
  if (matches.length === 0) return null
  const out: HastNode[] = []
  let at = 0
  for (const m of matches) {
    if (m.start > at) out.push({ type: 'text', value: value.slice(at, m.start) })
    out.push(linkElement(value.slice(m.start, m.end), m.path, m.line, m.column))
    at = m.end
  }
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
  return out
}

function walk(node: HastNode): void {
  if (!node.children) return
  const next: HastNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      next.push(...(splitText(child.value) ?? [child]))
      continue
    }
    if (child.type === 'element' && SKIP_TAGS.has(child.tagName ?? '')) {
      next.push(child)
      continue
    }
    walk(child)
    next.push(child)
  }
  node.children = next
}

export function rehypeFileLinks() {
  return (tree: HastNode): void => walk(tree)
}

export interface FileLinkTarget {
  path: string
  line?: number
  column?: number
}

export function fileLinkOf(props: Record<string, unknown>): FileLinkTarget | null {
  const path = props[FILE_LINK_PATH]
  if (typeof path !== 'string' || !path) return null
  const line = Number(props[FILE_LINK_LINE])
  const column = Number(props[FILE_LINK_COLUMN])
  const target: FileLinkTarget = { path }
  if (line > 0) target.line = line
  if (column > 0) target.column = column
  return target
}

export function wholeFileLink(text: string): FileLinkTarget | null {
  const trimmed = text.trim()
  const match = findFileLinks(trimmed).find((m) => m.start === 0 && m.end === trimmed.length)
  if (!match) return null
  const target: FileLinkTarget = { path: match.path }
  if (match.line) target.line = match.line
  if (match.column) target.column = match.column
  return target
}

export function isWebUrl(href: unknown): href is string {
  if (typeof href !== 'string') return false
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
