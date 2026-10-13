import { relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import picomatch from 'picomatch/posix'
import type { TreeChange, TreeChangeKind } from './fileWatch'

export const WATCHED_FILES_METHOD = 'workspace/didChangeWatchedFiles'
export const MAX_FILE_WATCHERS = 200
export const MAX_FILE_EVENTS = 500
const PATTERN_MAX = 1000
const WATCH_CREATE = 1
const WATCH_CHANGE = 2
const WATCH_DELETE = 4
const WATCH_ALL = WATCH_CREATE | WATCH_CHANGE | WATCH_DELETE

const KIND_BIT: Record<TreeChangeKind, number> = {
  created: WATCH_CREATE,
  changed: WATCH_CHANGE,
  deleted: WATCH_DELETE,
}

const FILE_CHANGE_TYPE: Record<TreeChangeKind, number> = { created: 1, changed: 2, deleted: 3 }

export interface FileWatcher {
  base: string | null
  matches: (path: string) => boolean
  kinds: number
}

export interface FileEvent {
  uri: string
  type: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`)
}

function filePath(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

function matcher(pattern: unknown): ((path: string) => boolean) | null {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > PATTERN_MAX) return null
  try {
    return picomatch(pattern, { dot: true })
  } catch {
    return null
  }
}

function parseWatcher(raw: unknown, root: string): FileWatcher | null {
  if (!isRecord(raw)) return null
  const kinds = typeof raw.kind === 'number' ? raw.kind & WATCH_ALL : WATCH_ALL
  const glob = raw.globPattern
  if (typeof glob === 'string') {
    const matches = matcher(glob)
    if (!matches) return null
    return { base: glob.startsWith('/') ? null : root, matches, kinds }
  }
  if (!isRecord(glob)) return null
  const base = filePath(isRecord(glob.baseUri) ? glob.baseUri.uri : glob.baseUri)
  const matches = matcher(glob.pattern)
  if (base === null || !matches || !isInside(base, root)) return null
  return { base, matches, kinds }
}

export function parseFileWatchers(registerOptions: unknown, root: string): FileWatcher[] {
  const list =
    isRecord(registerOptions) && Array.isArray(registerOptions.watchers)
      ? registerOptions.watchers
      : []
  const out: FileWatcher[] = []
  for (const raw of list.slice(0, MAX_FILE_WATCHERS)) {
    const watcher = parseWatcher(raw, root)
    if (watcher) out.push(watcher)
  }
  return out
}

function watches(watcher: FileWatcher, change: TreeChange): boolean {
  if ((watcher.kinds & KIND_BIT[change.kind]) === 0) return false
  if (watcher.base === null) return watcher.matches(change.path)
  if (!isInside(change.path, watcher.base) || change.path === watcher.base) return false
  return watcher.matches(relative(watcher.base, change.path))
}

export function watchedFileEvents(
  watchers: Iterable<FileWatcher>,
  changes: readonly TreeChange[],
  root: string,
): FileEvent[] {
  const list = [...watchers]
  const events: FileEvent[] = []
  for (const change of changes) {
    if (!isInside(change.path, root) || !list.some((watcher) => watches(watcher, change))) continue
    events.push({ uri: pathToFileURL(change.path).href, type: FILE_CHANGE_TYPE[change.kind] })
    if (events.length >= MAX_FILE_EVENTS) break
  }
  return events
}
