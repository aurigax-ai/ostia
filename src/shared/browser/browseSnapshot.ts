export interface SnapshotNode {
  role: string
  name: string
  ref?: string
  interactive?: boolean
  level?: number
  checked?: boolean | 'mixed'
  disabled?: boolean
  expanded?: boolean
  selected?: boolean
  value?: string
  url?: string
  children: SnapshotNode[]
}

export interface SnapshotOptions {
  interactive?: boolean
  compact?: boolean
  depth?: number
  urls?: boolean
}

export interface SnapshotRef {
  role: string
  name: string
}

export interface FormattedSnapshot {
  snapshot: string
  refs: Record<string, SnapshotRef>
}

export const TEXT_ROLE = 'text'

function isStructural(node: SnapshotNode): boolean {
  return node.role !== TEXT_ROLE && !node.interactive && !node.name
}

function keepInCompact(node: SnapshotNode): boolean {
  if (node.role === TEXT_ROLE) return node.name.length > 0
  if (node.interactive || node.name) return true
  return node.children.length > 0
}

function filterInteractive(nodes: SnapshotNode[]): SnapshotNode[] {
  const out: SnapshotNode[] = []
  for (const node of nodes) {
    const children = filterInteractive(node.children)
    if (node.interactive) out.push({ ...node, children })
    else out.push(...children)
  }
  return out
}

function compactNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const out: SnapshotNode[] = []
  for (const node of nodes) {
    const children = compactNodes(node.children)
    const next = { ...node, children }
    if (!keepInCompact(next)) continue
    if (isStructural(next) && children.length === 1) {
      out.push(children[0])
      continue
    }
    out.push(next)
  }
  return out
}

function attrsOf(node: SnapshotNode): string {
  const parts: string[] = []
  if (node.ref) parts.push(`[ref=${node.ref}]`)
  if (node.level !== undefined) parts.push(`[level=${node.level}]`)
  if (node.checked === 'mixed') parts.push('[checked=mixed]')
  else if (node.checked) parts.push('[checked]')
  if (node.disabled) parts.push('[disabled]')
  if (node.expanded !== undefined) parts.push(`[expanded=${node.expanded}]`)
  if (node.selected) parts.push('[selected]')
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function lineFor(node: SnapshotNode): string {
  if (node.role === TEXT_ROLE) return `- text: ${node.name}`
  const name = node.name ? ` ${JSON.stringify(node.name)}` : ''
  const value = node.value ? `: ${node.value}` : ''
  return `- ${node.role}${name}${attrsOf(node)}${value}`
}

export function formatSnapshot(
  root: SnapshotNode[],
  options: SnapshotOptions = {},
): FormattedSnapshot {
  let nodes = options.interactive ? filterInteractive(root) : root
  if (options.compact) nodes = compactNodes(nodes)
  const maxDepth =
    options.depth !== undefined && options.depth > 0 ? options.depth : Number.POSITIVE_INFINITY
  const lines: string[] = []
  const refs: Record<string, SnapshotRef> = {}
  const walk = (list: SnapshotNode[], depth: number): void => {
    if (depth >= maxDepth) return
    const indent = '  '.repeat(depth)
    for (const node of list) {
      lines.push(indent + lineFor(node))
      if (node.ref) refs[node.ref] = { role: node.role, name: node.name }
      if (options.urls && node.url) lines.push(`${indent}  - /url: ${node.url}`)
      walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return { snapshot: lines.join('\n'), refs }
}
