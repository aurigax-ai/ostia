import {
  BROWSE_LIMITS,
  type BrowseLimits,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { isArchivePath, parseArchivePath } from '../../../shared/archives/archivePaths'
import type { FsBinaryResult, FsEntry, FsKind, FsTextResult } from '../../../shared/files/filesApi'
import type { FileStat, VirtualSource } from '../fileSources'
import { closeFd, type EntryRead, openRegular } from './archiveFile'
import { type ArchiveTree, buildTree, type EntryRef } from './archiveTree'
import type { BrowseProviders, BrowseTarget } from './browseProviders'

const CACHED_ARCHIVES = 16
const TEXT_SNIFF_BYTES = 8192

interface Cached {
  key: string
  modified: number
  abort: AbortController
  settled: boolean
  tree: Promise<ArchiveTree | null>
}

interface Located {
  archive: string
  entry: string
  key: string
  modified: number
  kind: { extId: string; kind: string }
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
    private readonly providers: BrowseProviders,
    private readonly limits: BrowseLimits = BROWSE_LIMITS,
  ) {}

  dropCache(): void {
    for (const cached of this.cache.values()) {
      if (!cached.settled) cached.abort.abort()
    }
    this.cache.clear()
  }

  private async locate(path: string): Promise<Located | null> {
    const parsed = parseArchivePath(path)
    const archive = parsed ? this.confineArchive(parsed.archive) : null
    if (!parsed || !archive) return null
    const kind = this.providers.kindFor(archive)
    if (!kind) return null
    const opened = await openRegular(archive)
    if (!opened) return null
    const { fd, stat } = opened
    try {
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${kind.extId}:${kind.kind}`
      let cached = this.cache.get(archive)
      if (!cached || cached.key !== key) {
        cached?.abort.abort()
        const abort = new AbortController()
        const target: BrowseTarget = { ...kind, fd, size: stat.size }
        const entry: Cached = {
          key,
          modified: stat.mtimeMs,
          abort,
          settled: false,
          tree: this.providers
            .list(target, this.limits, abort.signal)
            .then((listing) =>
              listing.ok ? buildTree(listing.entries, this.limits, listing.cut) : null,
            ),
        }
        entry.tree = entry.tree.finally(() => {
          entry.settled = true
        })
        cached = entry
        this.cache.delete(archive)
        this.cache.set(archive, cached)
        while (this.cache.size > CACHED_ARCHIVES) {
          const oldest = this.cache.keys().next().value
          if (oldest === undefined) break
          const dropped = this.cache.get(oldest)
          if (dropped && !dropped.settled) dropped.abort.abort()
          this.cache.delete(oldest)
        }
      }
      const tree = await cached.tree
      return tree
        ? { archive, entry: parsed.entry, key, modified: cached.modified, kind, tree }
        : null
    } finally {
      closeFd(fd)
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
    const opened = await openRegular(found.archive)
    if (!opened) return { ok: false, problem: 'gone' }
    try {
      const { stat } = opened
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${found.kind.extId}:${found.kind.kind}`
      if (key !== found.key) return { ok: false, problem: 'gone' }
      const target: BrowseTarget = { ...found.kind, fd: opened.fd, size: stat.size }
      const result = await this.providers.read(
        target,
        ref.index,
        max,
        this.limits,
        new AbortController().signal,
      )
      return result.ok || result.problem !== 'too-large' ? result : { ...result, size: ref.size }
    } finally {
      closeFd(opened.fd)
    }
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
