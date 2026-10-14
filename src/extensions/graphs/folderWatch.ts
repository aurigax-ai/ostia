import { type Dirent, type FSWatcher, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import ignore, { type Ignore } from 'ignore'

const WATCH_FOLDERS_MAX = 5000
const ALWAYS_IGNORED = new Set(['.git', 'node_modules'])

export type WatchStart = { ok: true; folders: number } | { ok: false; reason: 'too-many-folders' }

function parentOf(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? '' : rel.slice(0, cut)
}

function entries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export class FolderWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly rules = new Map<string, Ignore>()

  constructor(
    private readonly root: string,
    private readonly onPath: (rel: string) => void,
    private readonly onRefused: () => void,
    private readonly max = WATCH_FOLDERS_MAX,
  ) {}

  start(): WatchStart {
    const folders = this.scan('', [])
    if (!folders) {
      this.rules.clear()
      return { ok: false, reason: 'too-many-folders' }
    }
    for (const dir of folders) this.watchDir(dir)
    return { ok: true, folders: folders.length }
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.rules.clear()
  }

  ignored(rel: string, isDir: boolean): boolean {
    const parts = rel.split('/')
    if (parts.some((part) => ALWAYS_IGNORED.has(part))) return true
    for (let i = 0; i < parts.length; i++) {
      const base = parts.slice(0, i).join('/')
      const rule = this.rules.get(base)
      if (!rule) continue
      const below = parts.slice(i).join('/')
      if (rule.ignores(isDir ? `${below}/` : below)) return true
    }
    return false
  }

  private loadRules(dir: string): void {
    try {
      const text = readFileSync(join(this.root, dir, '.gitignore'), 'utf8')
      this.rules.set(dir, ignore().add(text))
    } catch {
      this.rules.delete(dir)
    }
  }

  private scan(dir: string, out: string[]): string[] | null {
    this.loadRules(dir)
    out.push(dir)
    if (out.length > this.max) return null
    for (const entry of entries(join(this.root, dir))) {
      if (!entry.isDirectory()) continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (this.ignored(rel, true)) continue
      if (!this.scan(rel, out)) return null
    }
    return out
  }

  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return
    let watcher: FSWatcher
    try {
      watcher = watch(join(this.root, dir), (_event, name) => {
        if (typeof name !== 'string' || name.length === 0) return
        this.changed(dir ? `${dir}/${name}` : name)
      })
    } catch {
      return
    }
    watcher.on('error', () => {
      watcher.close()
      this.watchers.delete(dir)
    })
    this.watchers.set(dir, watcher)
  }

  private changed(rel: string): void {
    let isDir = false
    try {
      isDir = statSync(join(this.root, rel)).isDirectory()
    } catch {}
    if (rel.endsWith('.gitignore') && !isDir) this.loadRules(parentOf(rel))
    if (this.ignored(rel, isDir)) return
    if (isDir && !this.watchers.has(rel)) {
      const added = this.scan(rel, [])
      if (!added || this.watchers.size + added.length > this.max) {
        this.stop()
        this.onRefused()
        return
      }
      for (const dir of added) this.watchDir(dir)
      return
    }
    if (!isDir) this.onPath(rel)
  }
}
