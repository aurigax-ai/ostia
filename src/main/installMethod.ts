import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { app } from 'electron'
import { type EnvSource, readEnv } from '../shared/appEnv'
import { type InstallMethod, isInstallMethod } from '../shared/installMethod'
import { PRODUCT_NAME } from '../shared/product'

export const INSTALL_METHOD_ENV = 'INSTALL_METHOD'
export const APT_APP_DIR = `/opt/${PRODUCT_NAME}`
export const APT_PACKAGE_LIST = `/var/lib/dpkg/info/${PRODUCT_NAME}.list`
export const HOMEBREW_PREFIXES = ['/opt/homebrew', '/usr/local'] as const

export interface InstallProbe {
  execPath: string
  platform: NodeJS.Platform
  isPackaged: boolean
  env: EnvSource
  home: string
  exists: (path: string) => boolean
}

const isUnder = (path: string, dir: string): boolean => path.startsWith(`${dir}${sep}`)

export function localAppDir(env: EnvSource, home: string): string {
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
  if (isUnder(probe.execPath, APT_APP_DIR) && probe.exists(APT_PACKAGE_LIST)) return 'apt'
  if (isUnder(probe.execPath, localAppDir(probe.env, probe.home))) return 'local'
  return 'tarball'
}

export function seededInstallMethod(isPackaged: boolean, env: EnvSource): InstallMethod | null {
  if (isPackaged) return null
  const seeded = readEnv(INSTALL_METHOD_ENV, env)
  return isInstallMethod(seeded) ? seeded : null
}

function existsReal(path: string): boolean {
  try {
    realpathSync(path)
    return true
  } catch {
    return false
  }
}

let detected: InstallMethod | undefined

export function installMethod(): InstallMethod {
  if (detected !== undefined) return detected
  const seeded = seededInstallMethod(app.isPackaged, process.env)
  if (seeded) {
    detected = seeded
    return seeded
  }
  let execPath = process.execPath
  try {
    execPath = realpathSync(process.execPath)
  } catch {}
  detected = detectInstallMethod({
    execPath,
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    home: homedir(),
    exists: existsReal,
  })
  return detected
}
