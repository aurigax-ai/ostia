import { createHash } from 'node:crypto'
import {
  type Dirent,
  type FSWatcher,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  watch,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface FileChange {
  path: string
  exists: boolean
  owners: string[]
}

export type WatchDir = (
  path: string,
  listener: (event: string, name: string | null) => void,
) => FSWatcher

export const DARWIN_RECONCILE_MS = 1000

export function defaultReconcileMs(): number {
  return process.platform === 'darwin' ? DARWIN_RECONCILE_MS : 0
}

export interface FileWatchesDeps {
  confine: (path: string) => string | null
  debounceMs: number
  onChange: (change: FileChange) => void
  reconcileMs?: number
  watchDir?: WatchDir
}

interface DirWatch {
  watcher: FSWatcher
  files: Map<string, Set<string>>
}

function fingerprint(path: string): string | null {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export class FileWatches {
  private readonly dirs = new Map<string, DirWatch>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSeen = new Map<string, string | null>()
  private reconciler: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: FileWatchesDeps) {}

  watch(owner: string, path: string): boolean {
    const safe = this.deps.confine(path)
    if (safe === null) return false
    const dir = dirname(safe)
    let entry = this.dirs.get(dir)
    if (!entry) {
      let watcher: FSWatcher
      try {
        watcher = (this.deps.watchDir ?? watch)(dir, (_event, name) => {
          if (name) this.touched(dir, String(name))
        })
      } catch {
        return false
      }
      watcher.on('error', () => this.drop(dir))
      entry = { watcher, files: new Map() }
      this.dirs.set(dir, entry)
      this.startReconciling()
    }
    const name = basename(safe)
    const owners = entry.files.get(name) ?? new Set<string>()
    owners.add(owner)
    entry.files.set(name, owners)
    if (!this.lastSeen.has(safe)) this.lastSeen.set(safe, fingerprint(safe))
    return true
  }

  unwatch(owner: string, path: string): void {
    const safe = this.deps.confine(path)
    if (safe === null) return
    const dir = dirname(safe)
    const entry = this.dirs.get(dir)
    const owners = entry?.files.get(basename(safe))
    if (!entry || !owners) return
    owners.delete(owner)
    if (owners.size === 0) {
      entry.files.delete(basename(safe))
      this.lastSeen.delete(safe)
    }
    if (entry.files.size === 0) this.drop(dir)
  }

  unwatchOwner(owner: string): void {
    for (const [dir, entry] of [...this.dirs]) {
      for (const name of [...entry.files.keys()]) this.unwatch(owner, `${dir}/${name}`)
    }
  }

  watchedDirs(): string[] {
    return [...this.dirs.keys()].sort()
  }

  closeAll(): void {
    for (const dir of [...this.dirs.keys()]) this.drop(dir)
  }

  private startReconciling(): void {
    const every = this.deps.reconcileMs ?? defaultReconcileMs()
    if (this.reconciler || every <= 0) return
    this.reconciler = setInterval(() => this.reconcile(), every)
    this.reconciler.unref()
  }

  private reconcile(): void {
    for (const [dir, entry] of this.dirs) {
      const dirGone = !existsSync(dir)
      for (const name of entry.files.keys()) {
        const path = `${dir}/${name}`
        if (dirGone || (this.lastSeen.get(path) && !existsSync(path))) this.touched(dir, name)
      }
    }
  }

  private drop(dir: string): void {
    const entry = this.dirs.get(dir)
    if (!entry) return
    this.dirs.delete(dir)
    if (this.dirs.size === 0 && this.reconciler) {
      clearInterval(this.reconciler)
      this.reconciler = null
    }
    entry.watcher.close()
    for (const name of entry.files.keys()) {
      const path = `${dir}/${name}`
      clearTimeout(this.timers.get(path))
      this.timers.delete(path)
      this.lastSeen.delete(path)
    }
  }

  private touched(dir: string, name: string): void {
    const owners = this.dirs.get(dir)?.files.get(name)
    if (!owners) return
    const path = `${dir}/${name}`
    clearTimeout(this.timers.get(path))
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path)
        const current = this.dirs.get(dir)?.files.get(name)
        if (!current || current.size === 0) return
        const seen = existsSync(path) ? fingerprint(path) : null
        if (seen === this.lastSeen.get(path)) return
        this.lastSeen.set(path, seen)
        this.deps.onChange({ path, exists: seen !== null, owners: [...current] })
      }, this.deps.debounceMs),
    )
  }
}

export const TREE_WATCH_MAX_DIRS = 2000
export const TREE_WATCH_SKIPPED_DIRS: readonly string[] = ['.git', '.hg', '.svn', 'node_modules']

export type TreeChangeKind = 'created' | 'changed' | 'deleted'

export interface TreeChange {
  path: string
  kind: TreeChangeKind
}

export interface TreeWatchesDeps {
  confine: (dir: string) => string | null
  debounceMs: number
  maxDirs?: number
  reconcileMs?: number
  watchDir?: WatchDir
}

type TreeListener = (changes: TreeChange[]) => void

interface TreeWatch {
  dirs: Map<string, { watcher: FSWatcher; files: Set<string> }>
  listeners: Set<TreeListener>
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  reconciler: ReturnType<typeof setInterval> | null
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export class TreeWatches {
  private readonly trees = new Map<string, TreeWatch>()

  constructor(private readonly deps: TreeWatchesDeps) {}

  watch(root: string, listener: TreeListener): (() => void) | null {
    const safe = this.deps.confine(root)
    if (safe === null) return null
    let tree = this.trees.get(safe)
    if (!tree) {
      try {
        if (!lstatSync(safe).isDirectory()) return null
      } catch {
        return null
      }
      tree = {
        dirs: new Map(),
        listeners: new Set(),
        pending: new Set(),
        timer: null,
        reconciler: null,
      }
      this.trees.set(safe, tree)
      this.scan(tree, safe, null)
      this.startReconciling(tree)
    }
    const watched = tree
    watched.listeners.add(listener)
    return () => {
      watched.listeners.delete(listener)
      if (watched.listeners.size === 0 && this.trees.get(safe) === watched) this.close(safe)
    }
  }

  watchedDirs(root: string): string[] {
    return [...(this.trees.get(root)?.dirs.keys() ?? [])].sort()
  }

  closeAll(): void {
    for (const root of [...this.trees.keys()]) this.close(root)
  }

  private close(root: string): void {
    const tree = this.trees.get(root)
    if (!tree) return
    this.trees.delete(root)
    if (tree.timer) clearTimeout(tree.timer)
    if (tree.reconciler) clearInterval(tree.reconciler)
    for (const { watcher } of tree.dirs.values()) watcher.close()
    tree.dirs.clear()
    tree.listeners.clear()
  }

  private scan(tree: TreeWatch, start: string, created: TreeChange[] | null): void {
    const queue = [start]
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      if (tree.dirs.has(dir) || tree.dirs.size >= (this.deps.maxDirs ?? TREE_WATCH_MAX_DIRS)) {
        continue
      }
      const watched = dir
      let watcher: FSWatcher
      try {
        watcher = (this.deps.watchDir ?? watch)(watched, (_event, name) => {
          if (name) this.touched(tree, join(watched, String(name)))
        })
      } catch {
        continue
      }
      watcher.on('error', () => this.dropDir(tree, watched))
      const files = new Set<string>()
      tree.dirs.set(watched, { watcher, files })
      for (const entry of entriesOf(watched)) {
        if (entry.isDirectory()) {
          if (!TREE_WATCH_SKIPPED_DIRS.includes(entry.name)) queue.push(join(watched, entry.name))
          continue
        }
        files.add(entry.name)
        created?.push({ path: join(watched, entry.name), kind: 'created' })
      }
    }
  }

  private startReconciling(tree: TreeWatch): void {
    const every = this.deps.reconcileMs ?? defaultReconcileMs()
    if (every <= 0) return
    tree.reconciler = setInterval(() => this.reconcile(tree), every)
    tree.reconciler.unref()
  }

  private reconcile(tree: TreeWatch): void {
    const changes: TreeChange[] = []
    for (const dir of [...tree.dirs.keys()]) {
      const known = tree.dirs.get(dir)
      if (!known) continue
      let present = true
      try {
        present = lstatSync(dir).isDirectory()
      } catch {
        present = false
      }
      if (!present) {
        changes.push(...this.dropDir(tree, dir))
        continue
      }
      const names = new Set<string>()
      for (const entry of entriesOf(dir)) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!TREE_WATCH_SKIPPED_DIRS.includes(entry.name)) this.scan(tree, path, changes)
          continue
        }
        names.add(entry.name)
        if (!known.files.has(entry.name)) {
          known.files.add(entry.name)
          changes.push({ path, kind: 'created' })
        }
      }
      for (const name of [...known.files]) {
        if (names.has(name)) continue
        known.files.delete(name)
        changes.push({ path: join(dir, name), kind: 'deleted' })
      }
    }
    if (changes.length === 0) return
    for (const listener of [...tree.listeners]) listener(changes)
  }

  private dropDir(tree: TreeWatch, dir: string): TreeChange[] {
    const deleted: TreeChange[] = []
    const prefix = `${dir}/`
    for (const [path, entry] of [...tree.dirs]) {
      if (path !== dir && !path.startsWith(prefix)) continue
      entry.watcher.close()
      tree.dirs.delete(path)
      for (const name of entry.files) deleted.push({ path: join(path, name), kind: 'deleted' })
    }
    return deleted
  }

  private touched(tree: TreeWatch, path: string): void {
    tree.pending.add(path)
    if (tree.timer) return
    tree.timer = setTimeout(() => {
      tree.timer = null
      this.flush(tree)
    }, this.deps.debounceMs)
  }

  private flush(tree: TreeWatch): void {
    const changes: TreeChange[] = []
    for (const path of tree.pending) {
      const parent = tree.dirs.get(dirname(path))
      if (!parent) continue
      const name = basename(path)
      let directory = false
      let exists = true
      try {
        directory = lstatSync(path).isDirectory()
      } catch {
        exists = false
      }
      if (!exists) {
        if (parent.files.delete(name)) changes.push({ path, kind: 'deleted' })
        changes.push(...this.dropDir(tree, path))
      } else if (directory) {
        if (!TREE_WATCH_SKIPPED_DIRS.includes(name)) this.scan(tree, path, changes)
      } else {
        changes.push({ path, kind: parent.files.has(name) ? 'changed' : 'created' })
        parent.files.add(name)
      }
    }
    tree.pending.clear()
    if (changes.length === 0) return
    for (const listener of [...tree.listeners]) listener(changes)
  }
}
