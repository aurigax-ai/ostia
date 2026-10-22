import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { writeFileAtomicAsync } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { lock } from 'proper-lockfile'
import type { FolderTrust } from '../../shared/agents/agentsApi'
import { readRegularFile } from '../artifacts/previewFiles'
import { isInsidePath } from '../platform/pathGuard'

export interface TrustPlace {
  folder: string
  workDir: string
  home: string
  configDir?: string
  customOAuth?: boolean
}

export type ClaudeConfig = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown> | undefined>
}

interface ReadConfig {
  config: ClaudeConfig
  text: string
  target: string
  mode: number
}

const CONFIG_READ_MAX = 32 * 1024 * 1024
const GIT_POINTER_MAX = 4096
const WRITABLE = 0o222
const LOCK_RETRIES = { retries: 5, minTimeout: 50, maxTimeout: 500 }

function isRoot(path: string): boolean {
  return dirname(path) === path
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null
}

export async function claudeConfigFile(
  home: string,
  configDir?: string,
  customOAuth = false,
): Promise<string> {
  const current = join(configDir || home, `.claude${customOAuth ? '-custom-oauth' : ''}.json`)
  const legacy = join(configDir || join(home, '.claude'), '.config.json')
  const info = await stat(legacy).catch(() => null)
  if (
    info?.isFile() &&
    (info.size > 0 || ((info.mode & WRITABLE) !== 0 && !(await exists(current))))
  )
    return legacy
  return current
}

async function readText(path: string, max: number): Promise<string | null> {
  const read = await readRegularFile(path, max)
  return read.ok ? read.body.toString('utf8') : null
}

async function gitRoot(folder: string): Promise<string | null> {
  let dir = folder
  for (;;) {
    const entry = await lstat(join(dir, '.git')).catch(() => null)
    if (entry && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())) return dir
    if (isRoot(dir)) return null
    dir = dirname(dir)
  }
}

async function canonicalRoot(root: string): Promise<string> {
  const pointer = await readText(join(root, '.git'), GIT_POINTER_MAX)
  const gitDir = pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
  if (!gitDir) return root
  const common = await readText(join(resolvePath(root, gitDir), 'commondir'), GIT_POINTER_MAX)
  if (!common) return root
  const commonDir = resolvePath(root, gitDir, common.trim())
  return basename(commonDir) === '.git' ? dirname(commonDir) : root
}

async function readConfig(path: string): Promise<ReadConfig | null> {
  const target = await realpath(path).catch(() => null)
  if (!target) return null
  const info = await stat(target).catch(() => null)
  if (!info?.isFile()) return null
  const text = await readText(target, CONFIG_READ_MAX)
  if (text === null) return null
  try {
    const config: unknown = JSON.parse(text)
    return config && typeof config === 'object' && !Array.isArray(config)
      ? { config: config as ClaudeConfig, text, target, mode: info.mode & 0o777 }
      : null
  } catch {
    return null
  }
}

function accepted(config: ClaudeConfig, key: string): boolean {
  return config.projects?.[key]?.hasTrustDialogAccepted === true
}

function acceptedIn(config: ClaudeConfig, place: Resolved): boolean {
  if (place.canonical && accepted(config, place.canonical)) return true
  let dir = place.folder
  for (;;) {
    if (accepted(config, dir)) return true
    if ((place.root !== null && dir === place.root) || isRoot(dir)) return false
    dir = dirname(dir)
  }
}

interface Resolved {
  folder: string
  root: string | null
  canonical: string | null
  key: string | null
}

async function resolve(place: TrustPlace): Promise<Resolved | null> {
  const [folder, workDir, home] = await Promise.all(
    [place.folder, place.workDir, place.home].map((p) => realpath(p).catch(() => null)),
  )
  if (!folder || !workDir || !home || isRoot(workDir) || isInsidePath(workDir, home)) return null
  if (!(await stat(folder).catch(() => null))?.isDirectory()) return null
  const root = await gitRoot(folder)
  const canonical = root ? await canonicalRoot(root) : null
  const key = root ?? folder
  const allowed = !isRoot(key) && !isInsidePath(key, home) && isInsidePath(workDir, key)
  return { folder, root, canonical, key: allowed ? key : null }
}

export async function folderTrust(place: TrustPlace): Promise<FolderTrust> {
  const resolved = await resolve(place)
  if (!resolved) return { state: 'unknown' }
  const read = await readConfig(
    await claudeConfigFile(place.home, place.configDir, place.customOAuth),
  )
  if (!read) return { state: 'unknown' }
  if (acceptedIn(read.config, resolved)) return { state: 'trusted' }
  return resolved.key ? { state: 'ask', folder: resolved.key } : { state: 'unknown' }
}

export async function editClaudeConfig(
  path: string,
  edit: (config: ClaudeConfig) => ClaudeConfig | null,
): Promise<boolean> {
  if (!(await readConfig(path))) return false
  let compromised = false
  const release = await lock(path, {
    lockfilePath: `${path}.lock`,
    realpath: false,
    retries: LOCK_RETRIES,
    onCompromised: () => {
      compromised = true
    },
  }).catch(() => null)
  if (!release) return false
  try {
    const read = await readConfig(path)
    if (!read) return false
    const { config, text, target, mode } = read
    const next = edit(config)
    if (next === null) return true
    const out = `${JSON.stringify(next, null, 2)}${text.endsWith('\n') ? '\n' : ''}`
    if (compromised) return false
    await writeFileAtomicAsync(target, out, { mode })
    return true
  } finally {
    await release().catch(() => undefined)
  }
}

export async function trustFolder(place: TrustPlace, shown?: string): Promise<boolean> {
  const resolved = await resolve(place)
  if (!resolved?.key || (shown !== undefined && shown !== resolved.key)) return false
  const key = resolved.key
  const path = await claudeConfigFile(place.home, place.configDir, place.customOAuth)
  return editClaudeConfig(path, (config) =>
    acceptedIn(config, resolved)
      ? null
      : {
          ...config,
          projects: {
            ...config.projects,
            [key]: { ...config.projects?.[key], hasTrustDialogAccepted: true },
          },
        },
  )
}
