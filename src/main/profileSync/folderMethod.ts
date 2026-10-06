import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type SyncMethod, type SyncSnapshot, SyncTargetError, type WriteResult } from './engine'
import {
  TOP_FILES,
  readProfileFolders,
  readTopFile,
  removeRegularFile,
  writeAtomic,
} from './profile'

export function versionOf(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256')
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update('\0').update(text).update('\0')
  }
  return hash.digest('hex')
}

export class FolderMethod implements SyncMethod {
  constructor(
    readonly dir: string,
    readonly guarded: readonly string[],
  ) {}

  get id(): string {
    return `folder:${resolve(this.dir)}`
  }

  private check(): void {
    const dir = resolve(this.dir)
    if (this.guarded.some((p) => resolve(p) === dir)) throw new SyncTargetError('same-as-local')
    let isDir: boolean
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      throw new SyncTargetError('missing')
    }
    if (!isDir) throw new SyncTargetError('not-a-directory')
  }

  async read(): Promise<SyncSnapshot> {
    this.check()
    const folders = readProfileFolders(this.dir)
    const files = new Map<string, string>()
    const skipped = [...folders.skipped]
    for (const name of TOP_FILES) {
      const top = readTopFile(join(this.dir, name))
      if (top === 'skipped') skipped.push(name)
      else if (top) files.set(name, top.text)
    }
    for (const [path, text] of folders.files) files.set(path, text)
    return { files, version: versionOf(files), skipped: skipped.sort() }
  }

  async write(files: ReadonlyMap<string, string>, expected: string): Promise<WriteResult> {
    const current = await this.read()
    if (current.version !== expected) return { ok: false }
    for (const [path, text] of files) {
      if (current.files.get(path) !== text) writeAtomic(join(this.dir, path), text)
    }
    for (const path of current.files.keys()) {
      if (!files.has(path)) removeRegularFile(join(this.dir, path))
    }
    return { ok: true, version: versionOf(files) }
  }
}
