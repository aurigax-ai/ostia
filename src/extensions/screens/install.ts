import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk'
import { isOnPath, SCREENS_BIN } from './screensCli'

const SERVICE_PACKAGE = '@aurigax-ai/screens@latest'
export const SERVICE_INSTALL = ['pnpm', 'add', '-g', SERVICE_PACKAGE]
const SYSTEM_PROGRAMS = ['Xvnc', 'xdotool']

const SYSTEM_PACKAGES: Record<string, string[]> = {
  pacman: ['tigervnc', 'xdotool'],
  apt: ['tigervnc-standalone-server', 'xdotool'],
  dnf: ['tigervnc-server', 'xdotool'],
  zypper: ['xorg-x11-Xvnc', 'xdotool'],
}

const MANAGER_BINARIES: Record<string, string> = {
  pacman: 'pacman',
  apt: 'apt-get',
  dnf: 'dnf',
  zypper: 'zypper',
}

export interface InstallState {
  service: boolean
  missingPrograms: string[]
  systemInstall: string[] | null
}

function systemInstallArgv(onPath: (name: string) => boolean, reason: string): string[] | null {
  const manager = Object.keys(SYSTEM_PACKAGES).find((m) => onPath(MANAGER_BINARIES[m]))
  if (!manager) return null
  return [
    PRODUCT_NAME,
    'system',
    'install',
    ...SYSTEM_PACKAGES[manager],
    '--manager',
    manager,
    '--reason',
    reason,
  ]
}

export function installState(
  reason: string,
  onPath: (name: string) => boolean = (name) => isOnPath(name),
): InstallState {
  const missingPrograms = SYSTEM_PROGRAMS.filter((p) => !onPath(p))
  return {
    service: onPath(SCREENS_BIN),
    missingPrograms,
    systemInstall: missingPrograms.length > 0 ? systemInstallArgv(onPath, reason) : null,
  }
}
