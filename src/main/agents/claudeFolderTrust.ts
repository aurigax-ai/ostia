import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { writeFileAtomicAsync } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { FolderTrust } from '../../shared/types'

export interface TrustPlace {
  folder: string
  workDir: string
  home: string
  configDir?: string
}

type ClaudeConfig = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown> | undefined>
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

async function isFile(path: string): Promise<{ size: number } | null> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? info : null
}

export async function claudeConfigFile(home: string, configDir?: string): Promise<string> {
  const legacy = join(configDir || join(home, '.claude'), '.config.json')
  if (((await isFile(legacy))?.size ?? 0) > 0) return legacy
  return join(configDir || home, '.claude.json')
}

async function gitRoot(folder: string): Promise<string | null> {
  let dir = folder
  for (;;) {
    const entry = await lstat(join(dir, '.git')).catch(() => null)
    if (entry && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

async function readConfig(path: string): Promise<{ config: ClaudeConfig; text: string } | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const config: unknown = JSON.parse(text)
    return config && typeof config === 'object' && !Array.isArray(config)
      ? { config: config as ClaudeConfig, text }
      : null
  } catch {
    return null
  }
}

function acceptedIn(config: ClaudeConfig, folder: string, root: string | null): boolean {
  let dir = folder
  for (;;) {
    if (config.projects?.[dir]?.hasTrustDialogAccepted === true) return true
    if (root !== null && dir === root) return false
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

interface Resolved {
  folder: string
  root: string | null
  key: string | null
}

async function resolve(place: TrustPlace): Promise<Resolved | null> {
  const [folder, workDir, home] = await Promise.all(
    [place.folder, place.workDir, place.home].map((p) => realpath(p).catch(() => null)),
  )
  if (!folder || !workDir || !home) return null
  if (!(await stat(folder).catch(() => null))?.isDirectory()) return null
  const root = await gitRoot(folder)
  const key = root ?? folder
  const allowed = key !== dirname(key) && !within(home, key) && within(key, workDir)
  return { folder, root, key: allowed ? key : null }
}

export async function folderTrust(place: TrustPlace): Promise<FolderTrust> {
  const resolved = await resolve(place)
  if (!resolved) return { state: 'unknown' }
  const read = await readConfig(await claudeConfigFile(place.home, place.configDir))
  if (!read) return { state: 'unknown' }
  if (acceptedIn(read.config, resolved.folder, resolved.root)) return { state: 'trusted' }
  return resolved.key ? { state: 'ask', folder: resolved.key } : { state: 'unknown' }
}

export async function trustFolder(place: TrustPlace): Promise<boolean> {
  const resolved = await resolve(place)
  if (!resolved?.key) return false
  const path = await claudeConfigFile(place.home, place.configDir)
  const [read, info] = await Promise.all([readConfig(path), stat(path).catch(() => null)])
  if (!read || !info) return false
  const { config, text } = read
  const project = config.projects?.[resolved.key]
  if (project?.hasTrustDialogAccepted === true) return true
  const next: ClaudeConfig = {
    ...config,
    projects: { ...config.projects, [resolved.key]: { ...project, hasTrustDialogAccepted: true } },
  }
  const out = `${JSON.stringify(next, null, 2)}${text.endsWith('\n') ? '\n' : ''}`
  await writeFileAtomicAsync(path, out, { mode: info.mode & 0o777 })
  return true
}
