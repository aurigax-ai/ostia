import { PRODUCT_NAME } from './product'
import { DEFAULT_UPDATE_CHANNEL, type ReleaseInfo, type UpdateChannel } from './releases'
import { quoteArgv } from './shellQuote'

const INSTALL_METHODS = ['apt', 'brew', 'local', 'tarball', 'dmg', 'dev'] as const

export type InstallMethod = (typeof INSTALL_METHODS)[number]

export const UPDATE_COMMANDS: Readonly<Record<'apt' | 'brew', readonly (readonly string[])[]>> = {
  apt: [
    ['sudo', 'apt', 'update'],
    ['sudo', 'apt', 'install', '--only-upgrade', PRODUCT_NAME],
  ],
  brew: [['brew', 'upgrade', '--cask', PRODUCT_NAME]],
}

type ManagedInstallMethod = keyof typeof UPDATE_COMMANDS

const REPLACEABLE_METHODS: readonly InstallMethod[] = ['local', 'tarball']

export function isReplaceable(method: InstallMethod): boolean {
  return REPLACEABLE_METHODS.includes(method)
}

export function updateChannelFor(method: InstallMethod, picked: UpdateChannel): UpdateChannel {
  return isReplaceable(method) ? picked : DEFAULT_UPDATE_CHANNEL
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

type ReplaceBlock = 'not-writable' | 'system-path' | 'symlink' | 'leftover'

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
