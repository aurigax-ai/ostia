import { lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicAsync } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { type LockOptions, lock } from 'proper-lockfile'
import { isProfileId } from '../../../shared/claudeAccounts/claudeAccounts'
import { readRegularFile } from '../../artifacts/previewFiles'
import { appDataDir } from '../../platform/userDirs'
import { claudeConfigFile, editClaudeConfig } from '../claudeFolderTrust'
import { forgetKeychain, readKeychain, writeKeychain } from './keychain'
import type { OAuthProfile, OAuthTokens } from './signIn/anthropicOAuth'

const CONFIG_READ_MAX = 32 * 1024 * 1024
const PROFILE_MODE = 0o700
const CREDENTIAL_FILE = '.credentials.json'
const CREDENTIAL_LOCK = '.storage-write'
const CREDENTIAL_READ_MAX = 1024 * 1024
const CREDENTIAL_LOCK_OPTIONS = {
  realpath: false,
  stale: 15_000,
  retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
}
const PENDING_MARKER = '.ostia-pending'
const ACCOUNTS_DIR = 'claude-accounts'
const SHARED_FOLDERS = ['projects']
const SHARED_WHEN_PRESENT = [
  'keybindings.json',
  'CLAUDE.md',
  'skills',
  'commands',
  'agents',
  'history.jsonl',
]

export function accountsRoot(): string {
  return join(appDataDir(), ACCOUNTS_DIR)
}

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
  mkdirSync(root, { recursive: true, mode: PROFILE_MODE })
  mkdirSync(dir, { mode: PROFILE_MODE })
  writeFileSync(join(dir, PENDING_MARKER), '', { mode: 0o600 })
  for (const name of SHARED_FOLDERS) {
    mkdirSync(join(defaultHome, name), { recursive: true })
    symlinkSync(join(defaultHome, name), join(dir, name))
  }
  for (const name of SHARED_WHEN_PRESENT) {
    if (present(join(defaultHome, name))) symlinkSync(join(defaultHome, name), join(dir, name))
  }
  return dir
}

export async function removeProfile(root: string, id: string): Promise<void> {
  if (process.platform === 'darwin') await forgetKeychain(join(root, id))
  await rm(join(root, id), { recursive: true, force: true })
}

export async function acceptProfile(root: string, id: string): Promise<void> {
  await rm(join(root, id, PENDING_MARKER), { force: true })
}

export async function sweepPendingProfiles(
  root: string,
  olderThanMs: number,
  now: number,
  listed: ReadonlySet<string>,
  hasLogin: (dir: string) => Promise<boolean>,
): Promise<void> {
  const ids = await readdir(root).catch(() => [])
  for (const id of ids) {
    if (!isProfileId(id)) continue
    const marker = await stat(join(root, id, PENDING_MARKER)).catch(() => null)
    if (!marker || now - marker.mtimeMs <= olderThanMs) continue
    if (listed.has(id) || (await hasLogin(join(root, id)))) await acceptProfile(root, id)
    else await removeProfile(root, id)
  }
}

export async function acceptedProfileFolders(root: string): Promise<string[]> {
  const ids = await readdir(root).catch(() => [])
  const accepted: string[] = []
  for (const id of ids) {
    if (isProfileId(id) && !(await stat(join(root, id, PENDING_MARKER)).catch(() => null))) {
      accepted.push(id)
    }
  }
  return accepted
}

export async function accountEmail(configDir?: string): Promise<string | null> {
  const file = await realpath(await claudeConfigFile(homedir(), configDir)).catch(() => null)
  const read = file ? await readRegularFile(file, CONFIG_READ_MAX) : null
  if (!read?.ok) return null
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

export type LoginState = 'signed-in' | 'signed-out'

export async function loginState(
  dir: string,
  now: number,
  platform: NodeJS.Platform = process.platform,
): Promise<LoginState> {
  if (platform === 'darwin') return 'signed-in'
  const read = await readRegularFile(join(dir, CREDENTIAL_FILE), CREDENTIAL_READ_MAX)
  if (!read.ok) return 'signed-out'
  try {
    const oauth = (JSON.parse(read.body.toString('utf8')) as { claudeAiOauth?: unknown })
      .claudeAiOauth as { refreshToken?: unknown; refreshTokenExpiresAt?: unknown } | undefined
    if (typeof oauth?.refreshToken !== 'string' || oauth.refreshToken === '') return 'signed-out'
    const lapse = oauth.refreshTokenExpiresAt
    return typeof lapse === 'number' && lapse <= now ? 'signed-out' : 'signed-in'
  } catch {
    return 'signed-out'
  }
}

const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/
const TOKEN_MARGIN_MS = 60_000

export interface UsageToken {
  accessToken: string
  stamp: string
}

export async function credentialsStamp(dir: string): Promise<string | null> {
  const info = await stat(join(dir, CREDENTIAL_FILE)).catch(() => null)
  return info?.isFile() ? `${info.ino}:${info.size}:${info.mtimeMs}` : null
}

export async function usageToken(
  dir: string,
  now: number,
  platform: NodeJS.Platform = process.platform,
): Promise<UsageToken | null> {
  if (platform === 'darwin') return null
  const stamp = await credentialsStamp(dir)
  const read = stamp ? await readRegularFile(join(dir, CREDENTIAL_FILE), CREDENTIAL_READ_MAX) : null
  if (!stamp || !read?.ok) return null
  try {
    const oauth = (JSON.parse(read.body.toString('utf8')) as { claudeAiOauth?: unknown })
      .claudeAiOauth as { accessToken?: unknown; expiresAt?: unknown } | undefined
    const { accessToken, expiresAt } = oauth ?? {}
    if (typeof accessToken !== 'string' || !TOKEN_SHAPE.test(accessToken)) return null
    if (typeof expiresAt !== 'number' || expiresAt <= now + TOKEN_MARGIN_MS) return null
    return { accessToken, stamp }
  } catch {
    return null
  }
}

async function readCredentials(file: string): Promise<Record<string, unknown> | null> {
  if (!present(file)) return {}
  const read = await readRegularFile(file, CREDENTIAL_READ_MAX)
  if (!read.ok) return null
  try {
    const parsed: unknown = JSON.parse(read.body.toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function writeLogin(
  dir: string,
  tokens: OAuthTokens,
  profile: OAuthProfile,
  retries: LockOptions['retries'] = CREDENTIAL_LOCK_OPTIONS.retries,
): Promise<boolean> {
  const config = await claudeConfigFile(homedir(), dir)
  await writeFile(config, '{}\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined)
  const recorded = await editClaudeConfig(config, (current) => ({
    ...current,
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: profile.accountUuid,
      emailAddress: profile.emailAddress,
      displayName: profile.displayName,
      organizationUuid: profile.organizationUuid,
      organizationName: profile.organizationName,
    },
  }))
  if (!recorded) return false
  const release = await lock(join(dir, CREDENTIAL_LOCK), {
    ...CREDENTIAL_LOCK_OPTIONS,
    retries,
  }).catch(() => null)
  if (!release) return false
  try {
    const file = join(dir, CREDENTIAL_FILE)
    const keychain = process.platform === 'darwin'
    const existing = keychain ? await readKeychain(dir) : await readCredentials(file)
    if (!existing) return false
    const credentials = {
      ...existing,
      claudeAiOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        subscriptionType: profile.subscriptionType,
        rateLimitTier: profile.rateLimitTier,
      },
    }
    if (keychain) return await writeKeychain(dir, credentials)
    await writeFileAtomicAsync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  } finally {
    await release().catch(() => undefined)
  }
}
