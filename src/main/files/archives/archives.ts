import { stat } from 'node:fs/promises'
import type { EntryRead } from '../../../shared/archives/archiveFile'
import {
  isArchiveName,
  isArchivePath,
  parseArchivePath,
} from '../../../shared/archives/archivePaths'
import type { FsBinaryResult, FsEntry, FsKind, FsTextResult } from '../../../shared/files/filesApi'
import type { FileStat, VirtualSource } from '../fileSources'
import {
  ARCHIVE_LIMITS,
  type ArchiveLimits,
  type ArchiveTree,
  type EntryRef,
  buildTree,
} from './archiveTree'
import type { ExtensionReaders, ReaderChoice } from './extensionReader'
import { listTar, readTarEntry } from './tarArchive'
import { listZip, readZipEntry } from './zipArchive'

const ZIP_NAME = /\.(?:zip|jar)$/i
const CACHED_ARCHIVES = 16
const TEXT_SNIFF_BYTES = 8192

type Source = 'zip' | 'tar' | ReaderChoice

interface Cached {
  key: string
  modified: number
  source: Source
  tree: Promise<ArchiveTree | null>
}

interface Located {
  archive: string
  entry: string
  key: string
  modified: number
  source: Source
  tree: ArchiveTree
}

type Failure = Extract<EntryRead, { ok: false }>

function failure(read: Failure): Exclude<FsBinaryResult, { ok: true }> {
  if (read.problem === 'too-large') return { ok: false, error: 'too-large', size: read.size ?? 0 }
  if (read.problem === 'unreadable') return { ok: false, error: 'unreadable' }
  return { ok: false, error: 'archive', reason: read.problem }
}

export class Archives implements VirtualSource {
  readonly watchable = false
  private readonly cache = new Map<string, Cached>()

  constructor(
    private readonly confineArchive: (path: string) => string | null,
    private readonly limits: ArchiveLimits = ARCHIVE_LIMITS,
    private readonly readers: ExtensionReaders | null = null,
  ) {}

  handlesName(name: string): boolean {
    return isArchiveName(name, (other) => this.readers?.find(other) !== null)
  }

  private sourceOf(archive: string): Source | null {
    if (ZIP_NAME.test(archive)) return 'zip'
    if (isArchiveName(archive)) return 'tar'
    return this.readers?.find(archive) ?? null
  }

  private listed(archive: string, source: Source): Promise<ArchiveTree | null> {
    if (source === 'zip' || source === 'tar') {
      const raw = source === 'zip' ? listZip(archive, this.limits) : listTar(archive, this.limits)
      return raw.then((entries) => (entries ? buildTree(entries, this.limits) : null))
    }
    return (this.readers?.list(source, archive, this.limits) ?? Promise.resolve(null)).then(
      (listing) => {
        if (!listing) return null
        const tree = buildTree(listing.entries, this.limits)
        return listing.complete ? tree : { ...tree, cut: true }
      },
    )
  }

  private async locate(path: string): Promise<Located | null> {
    const parsed = parseArchivePath(path)
    const archive = parsed ? this.confineArchive(parsed.archive) : null
    if (!parsed || !archive) return null
    const info = await stat(archive).catch(() => null)
    if (!info?.isFile()) return null
    const key = `${info.size}:${info.mtimeMs}`
    let cached = this.cache.get(archive)
    if (cached && typeof cached.source === 'object' && !this.readers?.isActive(cached.source)) {
      this.cache.delete(archive)
      cached = undefined
    }
    if (!cached || cached.key !== key) {
      const source = this.sourceOf(archive)
      if (!source) return null
      cached = { key, modified: info.mtimeMs, source, tree: this.listed(archive, source) }
      this.cache.delete(archive)
      this.cache.set(archive, cached)
      while (this.cache.size > CACHED_ARCHIVES) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
    }
    const tree = await cached.tree
    if (!tree && typeof cached.source === 'object' && this.cache.get(archive) === cached) {
      this.cache.delete(archive)
    }
    if (!tree) return null
    return {
      archive,
      entry: parsed.entry,
      key,
      modified: cached.modified,
      source: cached.source,
      tree,
    }
  }

  handles(path: string): boolean {
    return isArchivePath(path)
  }

  confine(path: string): string | null {
    const parsed = parseArchivePath(path)
    return parsed && this.confineArchive(parsed.archive) ? path : null
  }

  async list(path: string): Promise<FsEntry[]> {
    const found = await this.locate(path)
    return found?.tree.dirs.get(found.entry) ?? []
  }

  async kind(path: string): Promise<FsKind | null> {
    const found = await this.locate(path)
    if (!found) return null
    if (found.tree.dirs.has(found.entry)) return 'dir'
    return found.tree.files.has(found.entry) ? 'file' : null
  }

  async version(path: string): Promise<string | null> {
    const found = await this.locate(path)
    return found?.tree.files.has(found.entry) ? `archive:${found.key}` : null
  }

  async describe(path: string): Promise<FileStat | null> {
    const found = await this.locate(path)
    const ref = found?.tree.files.get(found.entry)
    return found && ref ? { size: ref.size, modified: found.modified } : null
  }

  async read(path: string, max: number): Promise<EntryRead> {
    const found = await this.locate(path)
    const ref: EntryRef | undefined = found?.tree.files.get(found.entry)
    if (!found || !ref) return { ok: false, problem: 'gone' }
    if (ref.encrypted) return { ok: false, problem: 'encrypted' }
    if (ref.link !== null) return { ok: false, problem: 'link' }
    if (ref.size > max) return { ok: false, problem: 'too-large', size: ref.size }
    if (found.source === 'zip') return readZipEntry(found.archive, ref.index, max)
    if (found.source === 'tar') return readTarEntry(found.archive, ref.index, max, this.limits)
    if (!this.readers) return { ok: false, problem: 'gone' }
    return this.readers.read(found.source, found.archive, ref.index, max, this.limits)
  }

  async readBinary(path: string, max: number): Promise<FsBinaryResult> {
    const read = await this.read(path, max)
    return read.ok ? { ok: true, data: new Uint8Array(read.data) } : failure(read)
  }

  async readText(path: string, max: number): Promise<FsTextResult> {
    const read = await this.read(path, max)
    if (!read.ok) return failure(read)
    if (read.data.subarray(0, TEXT_SNIFF_BYTES).includes(0)) return { ok: false, error: 'binary' }
    return { ok: true, text: read.data.toString('utf8'), version: (await this.version(path)) ?? '' }
  }
}
