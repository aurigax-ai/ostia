import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { ipcMain } from 'electron'
import { LRUCache } from 'lru-cache'
import { type SandboxReadRules, sandboxPath } from '../sandbox/visibility'

export interface ShellState {
  path: string
  virtualEnv: string | null
  condaEnv: string | null
  kubeconfig: string | null
  histFile: string | null
  names: string[]
}

const SHELL_STATE_CAP_BYTES = 1024 * 1024

const SHELL_STATE_HEADER_LINES = 4

export function parseShellState(text: string): ShellState | null {
  const lines = text.split('\n')
  if (lines.length <= SHELL_STATE_HEADER_LINES) return null
  const [path, virtualEnv, condaEnv, kubeconfig, names, histFile] = lines
  return {
    path,
    virtualEnv: virtualEnv || null,
    condaEnv: condaEnv || null,
    kubeconfig: kubeconfig || null,
    histFile: histFile || null,
    names: names.split(/\s+/).filter(Boolean),
  }
}

export async function readShellState(file: string | null): Promise<ShellState | null> {
  if (!file) return null
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > SHELL_STATE_CAP_BYTES) return null
    return parseShellState(await readFile(file, 'utf8'))
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
  private readonly cache = new LRUCache<string, CachedListing>({ max: MAX_CACHED_PATHS })
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
    this.cache.set(path, { stamps, names })
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

export interface CommandsPane {
  owners: { has: (senderId: string) => boolean }
  localPrompt: boolean
  stateFile: string | null
  spawnPath: string
  rules: SandboxReadRules | null
}

export type CommandsPaneLookup = (paneId: string) => CommandsPane | null

export async function paneCommandNames(
  index: ExecutableIndex,
  pane: CommandsPane | null,
  senderId: string,
): Promise<string[]> {
  if (!pane?.owners.has(senderId) || !pane.localPrompt) return []
  const state = await readShellState(pane.stateFile)
  const path = state?.path ?? pane.spawnPath
  return commandNames(index, pane.rules ? sandboxPath(path, pane.rules) : path, state?.names ?? [])
}

export function registerCommandNamesIpc(index: ExecutableIndex, paneOf: CommandsPaneLookup): void {
  ipcMain.handle(
    'pty:commands',
    (e, paneId: string): Promise<string[]> =>
      paneCommandNames(index, paneOf(paneId), String(e.sender.id)),
  )
}
