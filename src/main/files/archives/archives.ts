import { stat } from 'node:fs/promises'
import { parseArchivePath } from '../../../shared/archives/archivePaths'
import type { FsBinaryResult, FsEntry, FsKind, FsTextResult } from '../../../shared/types'
import type { EntryRead } from './archiveFile'
import {
  ARCHIVE_LIMITS,
  type ArchiveLimits,
  type ArchiveTree,
  type EntryRef,
  buildTree,
} from './archiveTree'
import { listTar, readTarEntry } from './tarArchive'
import { listZip, readZipEntry } from './zipArchive'

const ZIP_NAME = /\.(?:zip|jar)$/i
const CACHED_ARCHIVES = 16
const TEXT_SNIFF_BYTES = 8192

interface Cached {
  key: string
  tree: Promise<ArchiveTree | null>
}

interface Located {
  archive: string
  entry: string
  key: string
  tree: ArchiveTree
}

export class Archives {
  private readonly cache = new Map<string, Cached>()

  constructor(
    private readonly confine: (path: string) => string | null,
    private readonly limits: ArchiveLimits = ARCHIVE_LIMITS,
  ) {}

  private async locate(path: string): Promise<Located | null> {
    const parsed = parseArchivePath(path)
    const archive = parsed ? this.confine(parsed.archive) : null
    if (!parsed || !archive) return null
    const info = await stat(archive).catch(() => null)
    if (!info?.isFile()) return null
    const key = `${info.size}:${info.mtimeMs}`
    let cached = this.cache.get(archive)
    if (!cached || cached.key !== key) {
      const raw = ZIP_NAME.test(archive)
        ? listZip(archive, this.limits)
        : listTar(archive, this.limits)
      cached = {
        key,
        tree: raw.then((entries) => (entries ? buildTree(entries, this.limits) : null)),
      }
      this.cache.delete(archive)
      this.cache.set(archive, cached)
      while (this.cache.size > CACHED_ARCHIVES) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
    }
    const tree = await cached.tree
    return tree ? { archive, entry: parsed.entry, key, tree } : null
  }

  async list(path: string): Promise<FsEntry[]> {
    const found = await this.locate(path)
    return found?.tree.dirs.get(found.entry) ?? []
  }

  async stat(path: string): Promise<FsKind | null> {
    const found = await this.locate(path)
    if (!found) return null
    if (found.tree.dirs.has(found.entry)) return 'dir'
    return found.tree.files.has(found.entry) ? 'file' : null
  }

  async version(path: string): Promise<string | null> {
    const found = await this.locate(path)
    return found?.tree.files.has(found.entry) ? `archive:${found.key}` : null
  }

  async size(path: string): Promise<{ size: number; modified: number } | null> {
    const found = await this.locate(path)
    const ref = found?.tree.files.get(found.entry)
    if (!found || !ref) return null
    return { size: ref.size, modified: Number(found.key.split(':')[1]) }
  }

  async read(path: string, max: number): Promise<EntryRead> {
    const found = await this.locate(path)
    const ref: EntryRef | undefined = found?.tree.files.get(found.entry)
    if (!found || !ref) return { ok: false, problem: 'gone' }
    if (ref.encrypted) return { ok: false, problem: 'encrypted' }
    if (ref.link !== null) return { ok: false, problem: 'link' }
    if (ref.size > max) return { ok: false, problem: 'too-large', size: ref.size }
    return ZIP_NAME.test(found.archive)
      ? readZipEntry(found.archive, ref.index, max)
      : readTarEntry(found.archive, ref.index, max, this.limits)
  }

  async readBinary(path: string, max: number): Promise<FsBinaryResult> {
    const read = await this.read(path, max)
    if (read.ok) return { ok: true, data: new Uint8Array(read.data) }
    if (read.problem === 'too-large') return { ok: false, error: 'too-large', size: read.size ?? 0 }
    if (read.problem === 'unreadable') return { ok: false, error: 'unreadable' }
    return { ok: false, error: 'archive', reason: read.problem }
  }

  async readText(path: string, max: number): Promise<FsTextResult> {
    const read = await this.read(path, max)
    if (!read.ok) {
      if (read.problem === 'too-large')
        return { ok: false, error: 'too-large', size: read.size ?? 0 }
      if (read.problem === 'unreadable') return { ok: false, error: 'unreadable' }
      return { ok: false, error: 'archive', reason: read.problem }
    }
    if (read.data.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return { ok: false, error: 'binary' }
    return { ok: true, text: read.data.toString('utf8'), version: (await this.version(path)) ?? '' }
  }
}
