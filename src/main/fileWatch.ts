import { createHash } from 'node:crypto'
import { type FSWatcher, existsSync, readFileSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'

export interface FileChange {
  path: string
  exists: boolean
  owners: string[]
}

export interface FileWatchesDeps {
  confine: (path: string) => string | null
  debounceMs: number
  onChange: (change: FileChange) => void
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

  constructor(private readonly deps: FileWatchesDeps) {}

  watch(owner: string, path: string): boolean {
    const safe = this.deps.confine(path)
    if (safe === null) return false
    const dir = dirname(safe)
    let entry = this.dirs.get(dir)
    if (!entry) {
      let watcher: FSWatcher
      try {
        watcher = watch(dir, (_event, name) => {
          if (name) this.touched(dir, String(name))
        })
      } catch {
        return false
      }
      watcher.on('error', () => this.drop(dir))
      entry = { watcher, files: new Map() }
      this.dirs.set(dir, entry)
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

  private drop(dir: string): void {
    const entry = this.dirs.get(dir)
    if (!entry) return
    this.dirs.delete(dir)
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
