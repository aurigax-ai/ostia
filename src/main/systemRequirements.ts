import { constants, accessSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { InstallHint, MissingRequirement } from '../shared/systemRequirements'

export interface Requirement {
  program: string
  package: string
  platforms: NodeJS.Platform[]
}

export interface RequirementEnv {
  platform?: NodeJS.Platform
  path?: string
}

export const SANDBOX_FEATURE = 'sandbox'

const registry = new Map<string, Requirement[]>([
  [
    SANDBOX_FEATURE,
    [
      { program: 'bwrap', package: 'bubblewrap', platforms: ['linux'] },
      { program: 'socat', package: 'socat', platforms: ['linux'] },
      { program: 'rg', package: 'ripgrep', platforms: ['linux', 'darwin'] },
    ],
  ],
])

export function registerRequirements(feature: string, requirements: Requirement[]): void {
  registry.set(feature, requirements)
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

export function onPath(program: string, path = process.env.PATH ?? ''): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => isExecutable(join(dir, program)))
}

export function missingRequirements(
  feature: string,
  env: RequirementEnv = {},
): MissingRequirement[] {
  const platform = env.platform ?? process.platform
  return (registry.get(feature) ?? [])
    .filter((r) => r.platforms.includes(platform) && !onPath(r.program, env.path))
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
