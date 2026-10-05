import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from '../shared/product'

export type UserDirKind = 'config' | 'data'

export type EnvSource = Record<string, string | undefined>

export const MIGRATED_MARKER = `.migrated-from-${LEGACY_PRODUCT_NAME}.json`
export const LEGACY_NOTICE = `MOVED-TO-${PRODUCT_NAME.toUpperCase()}.txt`
export const STAGING_DIR = `.${PRODUCT_NAME}-migration`

export const CHROMIUM_SKIP = [
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

export const DATA_SKIP = ['app']

const legacyKinds = new Set<UserDirKind>()

export function useLegacyDir(kind: UserDirKind): void {
  legacyKinds.add(kind)
}

export function resetUserDirs(): void {
  legacyKinds.clear()
}

export function configHome(env: EnvSource = process.env, home: string = homedir()): string {
  return env.XDG_CONFIG_HOME || join(home, '.config')
}

export function dataHome(env: EnvSource = process.env, home: string = homedir()): string {
  return env.XDG_DATA_HOME || join(home, '.local', 'share')
}

function dirName(kind: UserDirKind): string {
  return legacyKinds.has(kind) ? LEGACY_PRODUCT_NAME : PRODUCT_NAME
}

export function appConfigDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(configHome(env, home), dirName('config'))
}

export function appDataDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), dirName('data'))
}

export function legacyConfigDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(configHome(env, home), LEGACY_PRODUCT_NAME)
}

export function legacyDataDir(env: EnvSource = process.env, home: string = homedir()): string {
  return join(dataHome(env, home), LEGACY_PRODUCT_NAME)
}

export interface DirMove {
  from: string
  to: string
  skip?: readonly string[]
}

export type MoveStatus = 'nothing' | 'already' | 'copied' | 'failed'

export interface MoveResult {
  status: MoveStatus
  copied: string[]
  kept: string[]
  error?: string
}

export interface MoveHooks {
  copy?: (from: string, to: string) => void
  now?: () => Date
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
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

function isSpecialFile(path: string): boolean {
  try {
    const st = lstatSync(path)
    return st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()
  } catch {
    return false
  }
}

function copyTree(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (src) => !isSpecialFile(src),
  })
}

function notice(move: DirMove, at: string): string {
  return [
    `${PRODUCT_NAME} copied this folder to ${move.to} on ${at}.`,
    `${PRODUCT_NAME} now reads and writes only the new folder. Nothing here was changed or deleted,`,
    `so an older ${LEGACY_PRODUCT_NAME} still finds its data. Delete this folder once you no longer need it.`,
    '',
  ].join('\n')
}

export function migrateDir(move: DirMove, hooks: MoveHooks = {}): MoveResult {
  const result: MoveResult = { status: 'nothing', copied: [], kept: [] }
  if (!isDir(move.from)) return result
  if (present(join(move.to, MIGRATED_MARKER)) || present(join(move.from, LEGACY_NOTICE))) {
    result.status = 'already'
    return result
  }
  const copy = hooks.copy ?? copyTree
  const skip = new Set([...(move.skip ?? []), LEGACY_NOTICE])
  const createdTo = !present(move.to)
  const staging = join(move.to, STAGING_DIR)
  try {
    mkdirSync(move.to, { recursive: true, mode: statSync(move.from).mode & 0o777 })
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { mode: 0o700 })
    for (const name of readdirSync(move.from).sort()) {
      if (skip.has(name) || isSpecialFile(join(move.from, name))) continue
      if (present(join(move.to, name))) {
        result.kept.push(name)
        continue
      }
      copy(join(move.from, name), join(staging, name))
      renameSync(join(staging, name), join(move.to, name))
      result.copied.push(name)
    }
    rmSync(staging, { recursive: true, force: true })
    const at = (hooks.now?.() ?? new Date()).toISOString()
    writeFileSync(
      join(move.to, MIGRATED_MARKER),
      `${JSON.stringify({ from: move.from, at, copied: result.copied, kept: result.kept }, null, 2)}\n`,
      { mode: 0o600 },
    )
  } catch (err) {
    for (const name of result.copied) rmSync(join(move.to, name), { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
    if (createdTo) {
      try {
        rmdirSync(move.to)
      } catch {}
    }
    return { status: 'failed', copied: [], kept: result.kept, error: (err as Error).message }
  }
  result.status = 'copied'
  try {
    writeFileSync(join(move.from, LEGACY_NOTICE), notice(move, new Date().toISOString()))
  } catch {}
  return result
}

export interface UserDirsPlan {
  config: DirMove
  data: DirMove
  userData?: DirMove
}

export function userDirsPlan(
  appData: string,
  userDataOverridden: boolean,
  env: EnvSource = process.env,
  home: string = homedir(),
): UserDirsPlan {
  const plan: UserDirsPlan = {
    config: { from: legacyConfigDir(env, home), to: join(configHome(env, home), PRODUCT_NAME) },
    data: {
      from: legacyDataDir(env, home),
      to: join(dataHome(env, home), PRODUCT_NAME),
      skip: DATA_SKIP,
    },
  }
  if (!userDataOverridden) {
    plan.userData = {
      from: join(appData, LEGACY_PRODUCT_NAME),
      to: join(appData, PRODUCT_NAME),
      skip: CHROMIUM_SKIP,
    }
  }
  return plan
}

export interface UserDirsOutcome {
  config: MoveResult
  data: MoveResult
  userData?: MoveResult
}

export function migrateUserDirs(plan: UserDirsPlan, hooks: MoveHooks = {}): UserDirsOutcome {
  const sameAsConfig = plan.userData && plan.userData.from === plan.config.from
  const config = migrateDir(
    sameAsConfig && plan.userData
      ? {
          ...plan.config,
          skip: [...(plan.config.skip ?? []), ...(plan.userData.skip ?? [])],
        }
      : plan.config,
    hooks,
  )
  const data = migrateDir(plan.data, hooks)
  const userData = plan.userData
    ? sameAsConfig
      ? config
      : migrateDir(plan.userData, hooks)
    : undefined
  if (config.status === 'failed') useLegacyDir('config')
  if (data.status === 'failed') useLegacyDir('data')
  return { config, data, ...(userData ? { userData } : {}) }
}

export function describeOutcome(outcome: UserDirsOutcome): string[] {
  const lines: string[] = []
  for (const [kind, result] of Object.entries(outcome) as [string, MoveResult][]) {
    if (result.status === 'copied') {
      lines.push(
        `user dirs: copied ${kind} folder (${result.copied.length} entries${
          result.kept.length ? `, kept existing ${result.kept.join(', ')}` : ''
        })`,
      )
    } else if (result.status === 'failed') {
      lines.push(
        `user dirs: could not copy the ${kind} folder, using the ${LEGACY_PRODUCT_NAME} folder for now: ${result.error}`,
      )
    }
  }
  return lines
}
