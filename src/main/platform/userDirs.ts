import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_NAME } from '../../shared/product'

export type EnvSource = Record<string, string | undefined>

export const OLD_PRODUCT_NAME = 'pine'

export const RUNNING_LOCK = 'SingletonLock'

export const CHROMIUM_CACHES = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
]

export const INSTALLED_APP = 'app'

const RENAMED_ENTRIES: Readonly<Record<string, string>> = {
  [`Partitions/${OLD_PRODUCT_NAME}-browser`]: `Partitions/${PRODUCT_NAME}-browser`,
}

const MERGED_FOLDERS = new Set(['Partitions'])

export function configHome(env: EnvSource = process.env, home: string = homedir()): string {
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

export function dataHome(env: EnvSource = process.env, home: string = homedir()): string {
  return env.XDG_DATA_HOME || join(home, '.local', 'share')
}

export function appConfigDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(configHome(env, home), PRODUCT_NAME)
}

export function appDataDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), PRODUCT_NAME)
}

export interface DirMove {
  from: string
  to: string
  leave: readonly string[]
  drop: readonly string[]
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function holdsData(move: DirMove): boolean {
  return (
    isDir(move.from) &&
    readdirSync(move.from).some((name) => !move.leave.includes(name) && !move.drop.includes(name))
  )
}

export function oldDirMoves(
  appData: string,
  userDataOverridden: boolean,
  env: EnvSource = process.env,
  home: string = homedir(),
): DirMove[] {
  const config: DirMove = {
    from: join(configHome(env, home), OLD_PRODUCT_NAME),
    to: appConfigDir(env, home),
    leave: [],
    drop: [],
  }
  const data: DirMove = {
    from: join(dataHome(env, home), OLD_PRODUCT_NAME),
    to: appDataDir(env, home),
    leave: [INSTALLED_APP],
    drop: [],
  }
  const moves = [config, data]
  if (!userDataOverridden) {
    const userData = join(appData, OLD_PRODUCT_NAME)
    if (userData === config.from) config.drop = CHROMIUM_CACHES
    else {
      moves.push({
        from: userData,
        to: join(appData, PRODUCT_NAME),
        leave: [],
        drop: CHROMIUM_CACHES,
      })
    }
  }
  return moves.filter(holdsData)
}

export function savedWorkspaceFolders(
  files: readonly string[],
  home: string = homedir(),
): string[] {
  const folders = new Set<string>()
  for (const file of files) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { workspaces?: unknown }
      if (!Array.isArray(saved.workspaces)) continue
      for (const workspace of saved.workspaces) {
        const workDir = (workspace as { workDir?: unknown } | null)?.workDir
        if (typeof workDir !== 'string' || workDir === '') continue
        folders.add(workDir === '~' ? home : workDir.replace(/^~\//, `${home}/`))
      }
    } catch {}
  }
  return [...folders]
}

export function projectDirMoves(folders: readonly string[]): DirMove[] {
  return folders
    .map((folder) => ({
      from: join(folder, `.${OLD_PRODUCT_NAME}`),
      to: join(folder, `.${PRODUCT_NAME}`),
      leave: [],
      drop: [],
    }))
    .filter(holdsData)
}

export function oldAppRunning(moves: readonly DirMove[]): boolean {
  return moves.some((move) => present(join(move.from, RUNNING_LOCK)))
}

export interface MoveHooks {
  rename?: (from: string, to: string) => void
}

type Mover = ((from: string, to: string) => void) | null

export interface MoveResult {
  moved: string[]
  replaced: string[]
}

function moveEntry(from: string, to: string, rename: (from: string, to: string) => void): void {
  try {
    rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function moveInto(
  from: string,
  to: string,
  prefix: string,
  move: DirMove,
  result: MoveResult,
  rename: Mover,
): void {
  if (rename) mkdirSync(to, { recursive: true, mode: lstatSync(from).mode & 0o777 })
  for (const name of readdirSync(from).sort()) {
    const entry = `${prefix}${name}`
    const path = join(from, name)
    if (move.leave.includes(entry)) continue
    if (move.drop.includes(entry)) {
      if (rename) rmSync(path, { recursive: true, force: true })
      continue
    }
    const target = join(to, (RENAMED_ENTRIES[entry] ?? entry).slice(prefix.length))
    if (MERGED_FOLDERS.has(entry) && isDir(path)) {
      moveInto(path, target, `${entry}/`, move, result, rename)
      if (rename) rmSync(path, { recursive: true, force: true })
      continue
    }
    if (present(target)) {
      result.replaced.push(entry)
      if (rename) rmSync(path, { recursive: true, force: true })
      continue
    }
    if (rename) moveEntry(path, target, rename)
    result.moved.push(entry)
  }
}

export function previewOldDir(move: DirMove): MoveResult {
  const result: MoveResult = { moved: [], replaced: [] }
  moveInto(move.from, move.to, '', move, result, null)
  return result
}

export function moveOldDir(move: DirMove, hooks: MoveHooks = {}): MoveResult {
  const result: MoveResult = { moved: [], replaced: [] }
  moveInto(move.from, move.to, '', move, result, hooks.rename ?? renameSync)
  if (existsSync(move.from) && readdirSync(move.from).length === 0) rmdirSync(move.from)
  return result
}
