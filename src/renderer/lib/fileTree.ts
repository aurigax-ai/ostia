import type { FsEntry } from '@shared/types'
import { escapeRegExp } from 'es-toolkit'
import picomatch from 'picomatch/posix'
import type { FileSortBy, FileSortOrder } from '../settings/fileTreeSettings'

export type ExcludeMatcher = (path: string, root: string) => boolean

export function childPath(path: string, name: string): string {
  return path.endsWith('/') ? path + name : `${path}/${name}`
}

export function relativeToRoot(path: string, root: string): string | null {
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : null
}

export function isUnderExcluded(isExcluded: ExcludeMatcher, path: string, root: string): boolean {
  const rel = relativeToRoot(path, root)
  if (rel === null) return isExcluded(path, root)
  const base = root.endsWith('/') ? root : `${root}/`
  const parts = rel.split('/')
  return parts.some((_, i) => isExcluded(base + parts.slice(0, i + 1).join('/'), root))
}

function compileGlob(pattern: string): ((path: string) => boolean) | null {
  const trimmed = pattern.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    return picomatch(trimmed, { dot: true })
  } catch {
    return null
  }
}

export function excludeMatcher(patterns: readonly string[]): ExcludeMatcher {
  const tests = patterns.map(compileGlob).filter((t): t is (path: string) => boolean => !!t)
  if (tests.length === 0) return () => false
  return (path, root) => {
    const rel = relativeToRoot(path, root)
    return tests.some((test) => test(path) || (rel !== null && test(rel)))
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function typeKey(entry: FsEntry): string {
  if (entry.dir) return ''
  const dot = entry.name.lastIndexOf('.')
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : ''
}

export function sortEntries(
  entries: readonly FsEntry[],
  order: FileSortOrder,
  by: FileSortBy,
): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (order === 'foldersFirst' && a.dir !== b.dir) return a.dir ? -1 : 1
    if (by === 'type') {
      const byType = collator.compare(typeKey(a), typeKey(b))
      if (byType !== 0) return byType
    }
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  })
}

export interface NestingRule {
  parent: RegExp
  children: string[]
}

export function nestingRules(patterns: Readonly<Record<string, string>>): NestingRule[] {
  const rules: NestingRule[] = []
  for (const [key, value] of Object.entries(patterns)) {
    const parent = key.trim()
    if (!parent || parent.split('*').length > 2) continue
    const [head, tail = ''] = parent.split('*')
    const source = parent.includes('*')
      ? `^${escapeRegExp(head)}(.*)${escapeRegExp(tail)}$`
      : `^${escapeRegExp(parent)}$`
    const children = value
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    if (children.length > 0) rules.push({ parent: new RegExp(source, 'i'), children })
  }
  return rules
}

function basenameOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function extnameOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

function childMatcher(pattern: string, capture: string, parent: string): RegExp {
  const vars: Record<string, string> = {
    capture,
    basename: basenameOf(parent),
    extname: extnameOf(parent),
  }
  const source = pattern
    .split(/(\$\{[a-z]+\}|\*)/)
    .map((part) => {
      if (part === '*') return '.*'
      const variable = /^\$\{([a-z]+)\}$/.exec(part)
      if (variable && variable[1] in vars) return escapeRegExp(vars[variable[1]])
      return escapeRegExp(part)
    })
    .join('')
  return new RegExp(`^${source}$`, 'i')
}

export interface NestedEntry {
  entry: FsEntry
  nested: FsEntry[]
}

export function nestEntries(
  entries: readonly FsEntry[],
  rules: readonly NestingRule[],
): NestedEntry[] {
  if (rules.length === 0) return entries.map((entry) => ({ entry, nested: [] }))
  const files = entries.filter((e) => !e.dir)
  const parentOf = new Map<FsEntry, FsEntry>()
  const hasChildren = new Set<FsEntry>()
  for (const parent of files) {
    if (parentOf.has(parent)) continue
    const matchers: RegExp[] = []
    for (const rule of rules) {
      const m = rule.parent.exec(parent.name)
      if (!m) continue
      for (const child of rule.children) matchers.push(childMatcher(child, m[1] ?? '', parent.name))
    }
    if (matchers.length === 0) continue
    for (const file of files) {
      if (file === parent || parentOf.has(file) || hasChildren.has(file)) continue
      if (matchers.some((re) => re.test(file.name))) {
        parentOf.set(file, parent)
        hasChildren.add(parent)
      }
    }
  }
  const out: NestedEntry[] = []
  const byParent = new Map<FsEntry, NestedEntry>()
  for (const entry of entries) {
    if (parentOf.has(entry)) continue
    const item: NestedEntry = { entry, nested: [] }
    byParent.set(entry, item)
    out.push(item)
  }
  for (const entry of entries) {
    const parent = parentOf.get(entry)
    if (parent) byParent.get(parent)?.nested.push(entry)
  }
  return out
}

export interface CompactChain {
  names: string[]
  path: string
  entries: FsEntry[]
}

export async function compactChain(
  path: string,
  list: (path: string) => Promise<FsEntry[]>,
  visible: (entries: FsEntry[], path: string) => FsEntry[],
  maxDepth = 32,
): Promise<CompactChain> {
  const names: string[] = []
  let current = path
  let entries = visible(await list(current), current)
  while (names.length < maxDepth && entries.length === 1 && entries[0].dir) {
    names.push(entries[0].name)
    current = childPath(current, entries[0].name)
    entries = visible(await list(current), current)
  }
  return { names, path: current, entries }
}
