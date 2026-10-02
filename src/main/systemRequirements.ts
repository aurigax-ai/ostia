import { constants, accessSync, statSync } from 'node:fs'
import { MANAGER_FEATURE } from '../shared/managerSettings'
import { MARKETPLACE_FEATURE } from '../shared/marketplace'
import type { InstallHint, MissingRequirement } from '../shared/systemRequirements'
import { findOnPath } from './pathLookup'
import { needsPtyRelay } from './sandbox/ptyWrap'

export interface Requirement {
  program: string
  package: string
  platforms: NodeJS.Platform[]
  onlyWithPtyRelay?: boolean
}

export interface RequirementEnv {
  platform?: NodeJS.Platform
  path?: string
  ptyRelay?: boolean
}

export const SANDBOX_FEATURE = 'sandbox'

const registry = new Map<string, Requirement[]>([
  [
    SANDBOX_FEATURE,
    [
      { program: 'bwrap', package: 'bubblewrap', platforms: ['linux'] },
      { program: 'socat', package: 'socat', platforms: ['linux'] },
      { program: 'rg', package: 'ripgrep', platforms: ['linux', 'darwin'] },
      { program: 'script', package: 'util-linux', platforms: ['linux'], onlyWithPtyRelay: true },
    ],
  ],
  [MANAGER_FEATURE, [{ program: 'ss', package: 'iproute2', platforms: ['linux'] }]],
  [
    MARKETPLACE_FEATURE,
    [{ program: 'git', package: 'git', platforms: ['linux', 'darwin', 'win32'] }],
  ],
])

const labels = new Map<string, string>()

export function registerRequirements(
  feature: string,
  requirements: Requirement[],
  label?: string,
): void {
  if (requirements.length === 0) {
    registry.delete(feature)
    labels.delete(feature)
    return
  }
  registry.set(feature, requirements)
  if (label) labels.set(feature, label)
  else labels.delete(feature)
}

export function requirementLabel(feature: string): string {
  return labels.get(feature) ?? feature
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function programPath(program: string, path = process.env.PATH ?? ''): string | null {
  return findOnPath(program, path, isExecutable)
}

export function onPath(program: string, path = process.env.PATH ?? ''): boolean {
  return programPath(program, path) !== null
}

export function missingRequirements(
  feature: string,
  env: RequirementEnv = {},
): MissingRequirement[] {
  const platform = env.platform ?? process.platform
  const ptyRelay = env.ptyRelay ?? needsPtyRelay(false, undefined, platform)
  return (registry.get(feature) ?? [])
    .filter((r) => r.platforms.includes(platform) && !onPath(r.program, env.path))
    .filter((r) => !r.onlyWithPtyRelay || ptyRelay)
    .map((r) => ({ program: r.program, package: r.package }))
}

const INSTALLERS: { manager: string; command: (packages: string) => string }[] = [
  { manager: 'pacman', command: (p) => `sudo pacman -S --needed ${p}` },
  { manager: 'apt-get', command: (p) => `sudo apt-get install ${p}` },
  { manager: 'dnf', command: (p) => `sudo dnf install ${p}` },
  { manager: 'zypper', command: (p) => `sudo zypper install ${p}` },
  { manager: 'apk', command: (p) => `sudo apk add ${p}` },
  { manager: 'brew', command: (p) => `brew install ${p}` },
]

export function installHint(missing: MissingRequirement[], env: RequirementEnv = {}): InstallHint {
  const packages = [...new Set(missing.map((m) => m.package))]
  const installer = INSTALLERS.find((i) => onPath(i.manager, env.path))
  return { command: installer ? installer.command(packages.join(' ')) : null, packages }
}
