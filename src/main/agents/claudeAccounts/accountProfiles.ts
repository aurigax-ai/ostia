import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isProfileId } from '../../../shared/claudeAccounts/claudeAccounts'
import { readRegularFile } from '../../artifacts/previewFiles'
import { claudeConfigFile } from '../claudeFolderTrust'

const CONFIG_READ_MAX = 32 * 1024 * 1024
const PROFILE_MODE = 0o700
const CREDENTIAL_FILE = '.credentials.json'
const SHARED_FOLDERS = ['projects']
const SHARED_WHEN_PRESENT = [
  'settings.json',
  'keybindings.json',
  'CLAUDE.md',
  'skills',
  'commands',
  'agents',
  'history.jsonl',
]

export function defaultConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function createProfile(root: string, id: string, defaultHome: string): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true, mode: PROFILE_MODE })
  for (const name of SHARED_FOLDERS) {
    mkdirSync(join(defaultHome, name), { recursive: true })
    symlinkSync(join(defaultHome, name), join(dir, name))
  }
  for (const name of SHARED_WHEN_PRESENT) {
    if (present(join(defaultHome, name))) symlinkSync(join(defaultHome, name), join(dir, name))
  }
  return dir
}

export function removeProfile(root: string, id: string): void {
  rmSync(join(root, id), { recursive: true, force: true })
}

function profileIds(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

export function sweepProfiles(root: string, keep: ReadonlySet<string>): void {
  for (const id of profileIds(root)) {
    if (isProfileId(id) && !keep.has(id)) removeProfile(root, id)
  }
}

export async function accountEmail(configDir?: string): Promise<string | null> {
  const read = await readRegularFile(await claudeConfigFile(homedir(), configDir), CONFIG_READ_MAX)
  if (!read.ok) return null
  try {
    const { oauthAccount } = JSON.parse(read.body.toString('utf8')) as { oauthAccount?: unknown }
    const address = (oauthAccount as { emailAddress?: unknown } | undefined)?.emailAddress
    return typeof address === 'string' && address !== '' ? address : null
  } catch {
    return null
  }
}

export function credentialsPresent(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' || present(join(dir, CREDENTIAL_FILE))
}
