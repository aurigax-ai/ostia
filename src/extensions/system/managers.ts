import type { OsIdentity } from './os'

export const MANAGER_NAMES = [
  'pacman',
  'paru',
  'yay',
  'apt',
  'dnf',
  'zypper',
  'apk',
  'brew',
  'flatpak',
  'snap',
  'nix-env',
  'winget',
] as const

export type ManagerName = (typeof MANAGER_NAMES)[number]

interface ManagerSpec {
  needsRoot: boolean
  install: string[]
  onePackage?: true
}

const SPECS: Record<ManagerName, ManagerSpec> = {
  pacman: { needsRoot: true, install: ['-S', '--needed'] },
  paru: { needsRoot: false, install: ['-S', '--needed'] },
  yay: { needsRoot: false, install: ['-S', '--needed'] },
  apt: { needsRoot: true, install: ['install'] },
  dnf: { needsRoot: true, install: ['install'] },
  zypper: { needsRoot: true, install: ['install'] },
  apk: { needsRoot: true, install: ['add'] },
  brew: { needsRoot: false, install: ['install'] },
  flatpak: { needsRoot: false, install: ['install'] },
  snap: { needsRoot: true, install: ['install'] },
  'nix-env': { needsRoot: false, install: ['-iA'] },
  winget: { needsRoot: false, install: ['install', '--exact', '--id'], onePackage: true },
}

const SYSTEM_MANAGERS: ManagerName[] = [
  'pacman',
  'apt',
  'dnf',
  'zypper',
  'apk',
  'brew',
  'nix-env',
  'winget',
]

const FAMILY_MANAGER: Record<string, ManagerName> = {
  arch: 'pacman',
  cachyos: 'pacman',
  manjaro: 'pacman',
  endeavouros: 'pacman',
  garuda: 'pacman',
  artix: 'pacman',
  debian: 'apt',
  ubuntu: 'apt',
  linuxmint: 'apt',
  pop: 'apt',
  raspbian: 'apt',
  kali: 'apt',
  fedora: 'dnf',
  rhel: 'dnf',
  centos: 'dnf',
  rocky: 'dnf',
  almalinux: 'dnf',
  amzn: 'dnf',
  opensuse: 'zypper',
  'opensuse-leap': 'zypper',
  'opensuse-tumbleweed': 'zypper',
  suse: 'zypper',
  sles: 'zypper',
  alpine: 'apk',
  nixos: 'nix-env',
  macos: 'brew',
  windows: 'winget',
}

export const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+:-]*$/
export const PACKAGE_NAME_MAX = 128
export const MAX_PACKAGES = 32

export function isManagerName(name: string): name is ManagerName {
  return (MANAGER_NAMES as readonly string[]).includes(name)
}

export function invalidPackages(pkgs: string[]): string[] {
  return pkgs.filter((p) => p.length > PACKAGE_NAME_MAX || !PACKAGE_NAME.test(p))
}

export function executableNames(name: string, platform: string, pathExt: string): string[] {
  if (platform !== 'win32') return [name]
  return [
    name,
    ...pathExt
      .split(';')
      .filter(Boolean)
      .map((ext) => `${name}${ext.toLowerCase()}`),
  ]
}

export function findOnPath(
  name: string,
  env: { path: string; platform: string; pathExt?: string },
  isExecutable: (file: string) => boolean,
): string | null {
  const sep = env.platform === 'win32' ? ';' : ':'
  const slash = env.platform === 'win32' ? '\\' : '/'
  for (const dir of env.path.split(sep)) {
    if (!dir) continue
    for (const file of executableNames(name, env.platform, env.pathExt ?? '.EXE;.CMD;.BAT')) {
      const full = `${dir.replace(/[\\/]+$/, '')}${slash}${file}`
      if (isExecutable(full)) return full
    }
  }
  return null
}

export function defaultManager(os: OsIdentity, available: ManagerName[]): ManagerName | null {
  for (const family of [os.id, ...os.idLike]) {
    const preferred = FAMILY_MANAGER[family]
    if (preferred && available.includes(preferred)) return preferred
  }
  return SYSTEM_MANAGERS.find((m) => available.includes(m)) ?? null
}

export type InstallPlan = { ok: true; argv: string[] } | { ok: false; error: 'one-package-only' }

export function installArgv(
  manager: ManagerName,
  pkgs: string[],
  opts: { isRoot: boolean },
): InstallPlan {
  const spec = SPECS[manager]
  if (spec.onePackage && pkgs.length !== 1) return { ok: false, error: 'one-package-only' }
  const argv = [manager, ...spec.install, ...pkgs]
  return { ok: true, argv: spec.needsRoot && !opts.isRoot ? ['sudo', ...argv] : argv }
}
