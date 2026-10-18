import { randomUUID } from 'node:crypto'
import { fstat, read } from 'node:fs'
import { lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ArchiveReaderContribution,
  type ArchiveRequest,
  archiveReaderMatches,
} from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  type EntryRead,
  type RawEntry,
  closeFd,
  openRegular,
} from '../../../shared/archives/archiveFile'
import type { ArchiveLimits } from './archiveTree'

const ARCHIVE_READ_MS = 30_000
const ARCHIVE_LIST_CHARS_MAX = 32 * 1024 * 1024

const READ_PROBLEMS = new Set(['encrypted', 'link', 'gone', 'unzip-limit'])

export interface ArchiveReaderEntry {
  extId: string
  reader: ArchiveReaderContribution
}

export interface ArchiveReaderService {
  readers: () => ArchiveReaderEntry[]
  readDir: (extId: string) => string | null
  request: (extId: string, request: ArchiveRequest, timeoutMs: number) => Promise<unknown>
}

export interface ReaderChoice {
  extId: string
  reader: string
}

export interface ExtensionListing {
  entries: RawEntry[]
  complete: boolean
}

interface ReaderOptions {
  readMs: number
  listChars: number
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function entryOf(raw: unknown): RawEntry | null {
  if (!isRecord(raw)) return null
  const { name, index, dir, size, encrypted, link } = raw
  if (typeof name !== 'string' || !isCount(index) || !isCount(size)) return null
  if (typeof dir !== 'boolean' || typeof encrypted !== 'boolean') return null
  if (link !== null && typeof link !== 'string') return null
  return { name, index, dir, size, encrypted, link }
}

function parseListing(
  raw: unknown,
  limits: ArchiveLimits,
  charsMax: number,
): ExtensionListing | null {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.entries)) return null
  if (typeof raw.complete !== 'boolean') return null
  const kept = raw.entries.slice(0, limits.entries + 1)
  const entries: RawEntry[] = []
  let chars = 0
  for (const item of kept) {
    const entry = entryOf(item)
    if (!entry) return null
    chars += entry.name.length + (entry.link?.length ?? 0)
    if (chars > charsMax) return null
    entries.push(entry)
  }
  return { entries, complete: raw.complete && raw.entries.length <= limits.entries }
}

async function isRealDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return Boolean(info?.isDirectory() && !info.isSymbolicLink())
}

function sizeOf(fd: number): Promise<number | null> {
  return new Promise((resolve) => {
    fstat(fd, (error, stats) => resolve(error || !stats.isFile() ? null : stats.size))
  })
}

function readAt(fd: number, buffer: Buffer, at: number): Promise<number> {
  return new Promise((resolve) => {
    read(fd, buffer, at, buffer.length - at, at, (error, bytes) => resolve(error ? -1 : bytes))
  })
}

async function readExactly(fd: number, size: number): Promise<Buffer | null> {
  const data = Buffer.alloc(size + 1)
  let at = 0
  for (;;) {
    const bytes = await readAt(fd, data, at)
    if (bytes < 0) return null
    if (bytes === 0) break
    at += bytes
    if (at > size) return null
  }
  return at === size ? data.subarray(0, size) : null
}

async function readResult(dir: string, out: string, size: number, max: number) {
  if (size > max || !(await isRealDir(dir))) return null
  const fd = await openRegular(out)
  if (fd === null) return null
  try {
    if ((await sizeOf(fd)) !== size) return null
    return await readExactly(fd, size)
  } finally {
    closeFd(fd)
  }
}

function readProblem(raw: Record<string, unknown>): EntryRead {
  const error = raw.error
  if (error === 'too-large') {
    return { ok: false, problem: 'too-large', ...(isCount(raw.size) ? { size: raw.size } : {}) }
  }
  if (typeof error === 'string' && READ_PROBLEMS.has(error)) {
    return { ok: false, problem: error as 'encrypted' | 'link' | 'gone' | 'unzip-limit' }
  }
  return { ok: false, problem: 'unreadable' }
}

async function sweep(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name)
      return (entry.isDirectory() ? rmdir(path) : unlink(path)).catch(() => {})
    }),
  )
}

export class ExtensionReaders {
  private readonly options: ReaderOptions
  private readonly swept = new Map<string, Promise<void>>()

  constructor(
    private readonly service: () => ArchiveReaderService | null,
    options: Partial<ReaderOptions> = {},
  ) {
    this.options = { readMs: ARCHIVE_READ_MS, listChars: ARCHIVE_LIST_CHARS_MAX, ...options }
  }

  find(path: string): ReaderChoice | null {
    const found = this.service()
      ?.readers()
      .find((entry) => archiveReaderMatches(path, entry.reader))
    return found ? { extId: found.extId, reader: found.reader.id } : null
  }

  isActive(choice: ReaderChoice): boolean {
    return Boolean(
      this.service()
        ?.readers()
        .some((entry) => entry.extId === choice.extId && entry.reader.id === choice.reader),
    )
  }

  async list(
    choice: ReaderChoice,
    archive: string,
    limits: ArchiveLimits,
  ): Promise<ExtensionListing | null> {
    const service = this.service()
    if (!service) return null
    const request: ArchiveRequest = { op: 'list', reader: choice.reader, archive, limits }
    const raw = await service.request(choice.extId, request, limits.scanMs).catch(() => null)
    return parseListing(raw, limits, this.options.listChars)
  }

  async read(
    choice: ReaderChoice,
    archive: string,
    index: number,
    max: number,
    limits: ArchiveLimits,
  ): Promise<EntryRead> {
    const service = this.service()
    const dir = service?.readDir(choice.extId)
    if (!service || !dir) return { ok: false, problem: 'unreadable' }
    const made = await mkdir(dir, { recursive: true, mode: 0o700 }).then(
      () => true,
      () => false,
    )
    if (!made || !(await isRealDir(dir))) return { ok: false, problem: 'unreadable' }
    let swept = this.swept.get(dir)
    if (!swept) {
      swept = sweep(dir)
      this.swept.set(dir, swept)
    }
    await swept
    const out = join(dir, randomUUID())
    const request: ArchiveRequest = {
      op: 'read',
      reader: choice.reader,
      archive,
      index,
      max,
      out,
      limits,
    }
    try {
      const raw = await service
        .request(choice.extId, request, this.options.readMs)
        .catch(() => null)
      if (!isRecord(raw)) return { ok: false, problem: 'unreadable' }
      if (raw.ok !== true) return readProblem(raw)
      if (!isCount(raw.size)) return { ok: false, problem: 'unreadable' }
      const data = await readResult(dir, out, raw.size, max)
      return data ? { ok: true, data } : { ok: false, problem: 'unreadable' }
    } finally {
      await unlink(out).catch(() => {})
    }
  }
}
