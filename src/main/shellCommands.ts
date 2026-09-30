import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'

export interface ShellState {
  path: string
  names: string[]
}

const SHELL_STATE_CAP_BYTES = 1024 * 1024

export async function readShellState(file: string): Promise<ShellState | null> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > SHELL_STATE_CAP_BYTES) return null
    const text = await readFile(file, 'utf8')
    const newline = text.indexOf('\n')
    if (newline < 0) return null
    return {
      path: text.slice(0, newline),
      names: text
        .slice(newline + 1)
        .split(/\s+/)
        .filter(Boolean),
    }
  } catch {
    return null
  }
}

export function pathDirs(path: string, sep: string = delimiter): string[] {
  const seen = new Set<string>()
  for (const dir of path.split(sep)) {
    if (dir && isAbsolute(dir)) seen.add(dir)
  }
  return [...seen]
}

const WINDOWS_EXECUTABLE = new Set(['.exe', '.cmd', '.bat', '.com'])

async function executableName(dir: string, entry: Dirent): Promise<string | null> {
  if (!entry.isFile() && !entry.isSymbolicLink()) return null
  if (process.platform === 'win32') {
    const ext = extname(entry.name).toLowerCase()
    return WINDOWS_EXECUTABLE.has(ext) ? entry.name.slice(0, -ext.length) : null
  }
  try {
    const info = await stat(join(dir, entry.name))
    return info.isFile() && (info.mode & 0o111) !== 0 ? entry.name : null
  } catch {
    return null
  }
}

async function listExecutables(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = await Promise.all(entries.map((entry) => executableName(dir, entry)))
  return names.filter((name): name is string => name !== null)
}

async function dirStamp(dir: string): Promise<number> {
  try {
    return (await stat(dir)).mtimeMs
  } catch {
    return -1
  }
}

interface CachedListing {
  stamps: number[]
  names: string[]
}

const MAX_CACHED_PATHS = 16

export class ExecutableIndex {
  private readonly cache = new Map<string, CachedListing>()
  private readonly sep: string

  constructor(sep: string = delimiter) {
    this.sep = sep
  }

  async list(path: string): Promise<string[]> {
    const dirs = pathDirs(path, this.sep)
    const stamps = await Promise.all(dirs.map(dirStamp))
    const hit = this.cache.get(path)
    if (hit?.stamps.every((s, i) => s === stamps[i])) return hit.names
    const listed = await Promise.all(dirs.map(listExecutables))
    const names = [...new Set(listed.flat())].sort()
    this.cache.delete(path)
    this.cache.set(path, { stamps, names })
    if (this.cache.size > MAX_CACHED_PATHS) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return names
  }
}

export async function commandNames(
  index: ExecutableIndex,
  path: string,
  shellNames: readonly string[],
): Promise<string[]> {
  const executables = await index.list(path)
  return [...new Set([...executables, ...shellNames])].sort()
}
