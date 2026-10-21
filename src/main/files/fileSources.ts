import type { Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { FsBinaryResult, FsEntry, FsKind, FsTextResult } from '../../shared/files/filesApi'
import { resolveSafe } from '../platform/pathGuard'
import { readBinaryConfined } from './fsBinary'
import { type FsRangeResult, readRangeConfined } from './fsRange'
import { readTextConfined, versionConfined } from './fsText'

export interface FileStat {
  size: number
  modified: number
}

export interface FileSource {
  readonly watchable: boolean
  confine: (path: string) => string | null
  list: (path: string) => Promise<FsEntry[]>
  kind: (path: string) => Promise<FsKind | null>
  readText: (path: string, max: number) => Promise<FsTextResult>
  readBinary: (path: string, max: number) => Promise<FsBinaryResult>
  readRange?: (path: string, start: number, end: number) => Promise<FsRangeResult>
  version: (path: string) => Promise<string | null>
  describe: (path: string) => Promise<FileStat | null>
}

export interface VirtualSource extends FileSource {
  handles: (path: string) => boolean
}

async function listDir(dir: string, browsable: (name: string) => boolean): Promise<FsEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .map((d) =>
      d.isFile() && browsable(d.name)
        ? { name: d.name, dir: false, archive: true as const }
        : { name: d.name, dir: d.isDirectory() },
    )
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

function statOf(path: string | null): Promise<Stats | null> {
  return path === null ? Promise.resolve(null) : stat(path).catch(() => null)
}

export function localSource(
  roots: () => string[],
  confine: (path: string) => string | null,
  browsable: () => (name: string) => boolean,
): FileSource {
  return {
    watchable: true,
    confine,
    list: async (path) => {
      const safe = resolveSafe(path, roots())
      return safe === null ? [] : listDir(safe, browsable())
    },
    kind: async (path) => {
      const found = await statOf(confine(path))
      return found?.isFile() ? 'file' : found?.isDirectory() ? 'dir' : null
    },
    readText: (path, max) => readTextConfined(path, confine, max),
    readBinary: async (path, max) => readBinaryConfined(path, confine, max),
    readRange: (path, start, end) => readRangeConfined(path, start, end, confine),
    version: (path) => versionConfined(path, confine),
    describe: async (path) => {
      const found = await statOf(confine(path))
      return found?.isFile() ? { size: found.size, modified: found.mtimeMs } : null
    },
  }
}

export class FileSources {
  constructor(
    private readonly local: FileSource,
    private readonly virtual: readonly VirtualSource[],
  ) {}

  of(path: string): FileSource {
    return this.virtual.find((source) => source.handles(path)) ?? this.local
  }
}
