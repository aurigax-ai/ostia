import { PRODUCT_NAME } from './product'
import type { ReleaseInfo } from './releases'
import { quoteArgv } from './shellQuote'

export const INSTALL_METHODS = ['apt', 'brew', 'local', 'tarball', 'dmg', 'dev'] as const

export type InstallMethod = (typeof INSTALL_METHODS)[number]

export const UPDATE_COMMANDS: Readonly<Record<'apt' | 'brew', readonly (readonly string[])[]>> = {
  apt: [
    ['sudo', 'apt', 'update'],
    ['sudo', 'apt', 'install', '--only-upgrade', PRODUCT_NAME],
  ],
  brew: [['brew', 'upgrade', '--cask', PRODUCT_NAME]],
}

export type ManagedInstallMethod = keyof typeof UPDATE_COMMANDS

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

export interface ReleaseState {
  release: ReleaseInfo | null
  method: InstallMethod
  updateCommand: string | null
}
