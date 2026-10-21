import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type EnvSource, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app } from 'electron'
import {
  hasAppFolder,
  type InstallMethod,
  isInstallMethod,
  isMacInstall,
} from '../../shared/app/installMethod'
import { isInsidePath } from '../platform/pathGuard'

const INSTALL_METHOD_ENV = 'INSTALL_METHOD'
const INSTALL_APP_DIR_ENV = 'INSTALL_APP_DIR'
const APT_APP_DIR = `/opt/${PRODUCT_NAME}`
const APT_PACKAGE_LIST = `/var/lib/dpkg/info/${PRODUCT_NAME}.list`
const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'] as const

export interface InstallProbe {
  execPath: string
  platform: NodeJS.Platform
  isPackaged: boolean
  env: EnvSource
  home: string
  exists: (path: string) => boolean
}

function localAppDir(env: EnvSource, home: string): string {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return join(dataHome, PRODUCT_NAME, 'app')
}

function caskReceipt(probe: InstallProbe): boolean {
  const prefixes = probe.env.HOMEBREW_PREFIX ? [probe.env.HOMEBREW_PREFIX] : HOMEBREW_PREFIXES
  return prefixes.some((prefix) => probe.exists(join(prefix, 'Caskroom', PRODUCT_NAME)))
}

export function detectInstallMethod(probe: InstallProbe): InstallMethod {
  if (!probe.isPackaged) return 'dev'
  if (probe.platform === 'darwin') {
    return probe.execPath.includes('.app/') && caskReceipt(probe) ? 'brew' : 'dmg'
  }
  if (isInsidePath(APT_APP_DIR, probe.execPath) && probe.exists(APT_PACKAGE_LIST)) return 'apt'
  if (isInsidePath(localAppDir(probe.env, probe.home), probe.execPath)) return 'local'
  return 'tarball'
}

export function seededInstallMethod(isPackaged: boolean, env: EnvSource): InstallMethod | null {
  if (isPackaged) return null
  const seeded = readEnv(INSTALL_METHOD_ENV, env)
  return isInstallMethod(seeded) ? seeded : null
}

function realExecPath(): string {
  try {
    return realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

export function installAppDir(): string | null {
  const method = installMethod()
  return replaceableAppDir({
    method,
    isPackaged: app.isPackaged,
    execPath: isMacInstall(method) ? process.execPath : realExecPath(),
    env: process.env,
  })
}

const BUNDLE_EXECUTABLE = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/

export function appBundleOf(execPath: string): string | null {
  return BUNDLE_EXECUTABLE.exec(execPath)?.[1] ?? null
}

function existsReal(path: string): boolean {
  try {
    realpathSync(path)
    return true
  } catch {
    return false
  }
}

export function replaceableAppDir(opts: {
  method: InstallMethod
  isPackaged: boolean
  execPath: string
  env: EnvSource
}): string | null {
  if (!hasAppFolder(opts.method)) return null
  if (!opts.isPackaged) return readEnv(INSTALL_APP_DIR_ENV, opts.env) ?? null
  return isMacInstall(opts.method) ? appBundleOf(opts.execPath) : dirname(opts.execPath)
}

let detected: InstallMethod | undefined

export function installMethod(): InstallMethod {
  if (detected !== undefined) return detected
  const seeded = seededInstallMethod(app.isPackaged, process.env)
  if (seeded) {
    detected = seeded
    return seeded
  }
  detected = detectInstallMethod({
    execPath: realExecPath(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    home: homedir(),
    exists: existsReal,
  })
  return detected
}
