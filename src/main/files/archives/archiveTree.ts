import type { BrowseLimits } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import type { FsEntry } from '../../../shared/files/filesApi'

export interface RawEntry {
  name: string
  index: number
  dir: boolean
  size: number
  encrypted: boolean
  link: string | null
}

export interface EntryRef {
  index: number
  size: number
  encrypted: boolean
  link: string | null
}

export interface ArchiveTree {
  dirs: Map<string, FsEntry[]>
  files: Map<string, EntryRef>
  cut: boolean
}

function shownText(text: string, limit: number): string {
  const escaped = text.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (c) => {
    const code = c.codePointAt(0) ?? 0
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
  })
  return escaped.length > limit ? `${escaped.slice(0, limit)}…` : escaped
}

export function segmentsOf(name: string, limits: BrowseLimits): string[] {
  const parts = name
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .map((part) => shownText(part, limits.nameLength))
  if (parts.length <= limits.depth) return parts
  return [...parts.slice(0, limits.depth - 1), parts.slice(limits.depth - 1).join('／')]
}

function joined(parts: string[]): string {
  return parts.join('/')
}

export function buildTree(raw: RawEntry[], limits: BrowseLimits, cut = false): ArchiveTree {
  const dirs = new Map<string, FsEntry[]>([['', []]])
  const files = new Map<string, EntryRef>()
  const kept = raw.slice(0, limits.entries)
  const ensureDir = (parts: string[]): void => {
    for (let i = 1; i <= parts.length; i++) {
      const path = joined(parts.slice(0, i))
      if (dirs.has(path)) continue
      dirs.set(path, [])
      dirs.get(joined(parts.slice(0, i - 1)))?.push({ name: parts[i - 1], dir: true })
    }
  }
  const placed = kept.map((entry) => ({ entry, parts: segmentsOf(entry.name, limits) }))
  for (const { entry, parts } of placed) {
    if (parts.length === 0) continue
    ensureDir(entry.dir ? parts : parts.slice(0, -1))
  }
  for (const { entry, parts } of placed) {
    if (entry.dir || parts.length === 0) continue
    const parent = joined(parts.slice(0, -1))
    const siblings = dirs.get(parent) ?? []
    const base = parts[parts.length - 1]
    let name = base
    for (let n = 2; siblings.some((sibling) => sibling.name === name); n++) name = `${base} (${n})`
    const path = parent ? `${parent}/${name}` : name
    files.set(path, {
      index: entry.index,
      size: entry.size,
      encrypted: entry.encrypted,
      link: entry.link,
    })
    siblings.push({
      name,
      dir: false,
      ...(entry.link !== null ? { link: shownText(entry.link, limits.nameLength) } : {}),
      ...(entry.encrypted ? { encrypted: true as const } : {}),
    })
  }
  return { dirs, files, cut: cut || raw.length > limits.entries }
}
