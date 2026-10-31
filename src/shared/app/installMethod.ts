import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { quoteArgv } from '../terminal/shellQuote'
import { DEFAULT_UPDATE_CHANNEL, type ReleaseInfo, type UpdateChannel } from './releases'

const INSTALL_METHODS = ['apt', 'brew', 'local', 'tarball', 'dmg', 'dev'] as const

export type InstallMethod = (typeof INSTALL_METHODS)[number]

const UPDATE_COMMANDS: Readonly<Record<'apt' | 'brew', readonly (readonly string[])[]>> = {
  apt: [
    ['sudo', 'apt', 'update'],
    ['sudo', 'apt', 'install', '--only-upgrade', PRODUCT_NAME],
  ],
  brew: [['brew', 'upgrade', '--cask', PRODUCT_NAME]],
}

type ManagedInstallMethod = keyof typeof UPDATE_COMMANDS

const MAC_METHODS: readonly InstallMethod[] = ['dmg', 'brew']

export function isMacInstall(method: InstallMethod): boolean {
  return MAC_METHODS.includes(method)
}

export function offeredChannels(method: InstallMethod, dirty = false): readonly UpdateChannel[] {
  if (isMacInstall(method)) return ['stable', 'beta']
  if (method === 'local' || method === 'tarball') {
    return dirty ? ['stable', 'beta'] : ['stable', 'beta', 'main']
  }
  return [DEFAULT_UPDATE_CHANNEL]
}

export function updateChannelFor(
  method: InstallMethod,
  picked: UpdateChannel,
  dirty = false,
): UpdateChannel {
  return offeredChannels(method, dirty).includes(picked) ? picked : DEFAULT_UPDATE_CHANNEL
}

export function hasAppFolder(method: InstallMethod): boolean {
  return method !== 'apt' && method !== 'dev'
}

export function replacesInApp(method: InstallMethod, picked: UpdateChannel): boolean {
  if (method === 'brew') return updateChannelFor(method, picked) === 'beta'
  return hasAppFolder(method)
}

export function isInstallMethod(value: unknown): value is InstallMethod {
  return typeof value === 'string' && (INSTALL_METHODS as readonly string[]).includes(value)
}

export function managedUpdateMethod(method: InstallMethod): ManagedInstallMethod | null {
  return method === 'apt' || method === 'brew' ? method : null
}

export function updateCommandLine(method: InstallMethod): string | null {
  const managed = managedUpdateMethod(method)
  if (!managed) return null
  return UPDATE_COMMANDS[managed].map((argv) => quoteArgv([...argv])).join(' && ')
}

export type UpdateRunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'failed'; exitCode: number | null }

export type UpdateRunStart = 'opened' | 'no-action' | 'busy' | 'not-opened'

export const UPDATE_DOWNLOAD_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

type ReplaceBlock =
  | 'not-writable'
  | 'system-path'
  | 'symlink'
  | 'leftover'
  | 'translocated'
  | 'read-only'
  | 'unsupported'

export type ReplaceAvailability = { ok: true } | { ok: false; reason: ReplaceBlock; path?: string }

export type ReplaceFailure =
  | 'blocked'
  | 'offline'
  | 'http-error'
  | 'redirect-refused'
  | 'too-large'
  | 'no-checksum'
  | 'checksum-mismatch'
  | 'bad-archive'
  | 'extract-failed'
  | 'not-executable'
  | 'wrong-version'
  | 'swap-failed'
  | 'mount-failed'
  | 'bad-signature'
  | 'wrong-team'
  | 'not-notarized'

export type ReplaceState =
  | { status: 'idle' }
  | { status: 'downloading' }
  | { status: 'installing' }
  | { status: 'done'; version: string }
  | { status: 'failed'; reason: ReplaceFailure }

export interface ReplaceProgress {
  received: number
  total: number
}

export type ReplaceStart = 'started' | 'busy' | 'no-action'

export interface ReleaseState {
  release: ReleaseInfo | null
  method: InstallMethod
  updateCommand: string | null
  replace: ReplaceAvailability | null
}
