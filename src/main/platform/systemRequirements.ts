import { execFileSync } from 'node:child_process'
import { constants, accessSync, statSync } from 'node:fs'
import { DISCRETE_GPU_FEATURE } from '../../shared/discreteGpu'
import { KEEP_SHELLS_FEATURE, TMUX_MIN_VERSION } from '../../shared/keepShells'
import { MANAGER_FEATURE } from '../../shared/managerSettings'
import { MARKETPLACE_FEATURE } from '../../shared/marketplace'
import type { InstallHint, MissingRequirement } from '../../shared/systemRequirements'
import { needsPtyRelay } from '../sandbox/ptyWrap'
import { findOnPath } from './pathLookup'

export interface Requirement {
  program: string
  package: string
  platforms: NodeJS.Platform[]
  onlyWithPtyRelay?: boolean
  minVersion?: { args: string[]; version: string }
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
    KEEP_SHELLS_FEATURE,
    [
      {
        program: 'tmux',
        package: 'tmux',
        platforms: ['linux', 'darwin'],
        minVersion: { args: ['-V'], version: TMUX_MIN_VERSION },
      },
    ],
  ],
  [
    DISCRETE_GPU_FEATURE,
    [
      { program: 'switcherooctl', package: 'switcheroo-control', platforms: ['linux'] },
      { program: 'busctl', package: 'systemd', platforms: ['linux'] },
    ],
  ],
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
  const missing: MissingRequirement[] = []
  for (const r of registry.get(feature) ?? []) {
    if (!r.platforms.includes(platform) || (r.onlyWithPtyRelay && !ptyRelay)) continue
    const path = programPath(r.program, env.path)
    if (!path) {
      missing.push({ program: r.program, package: r.package })
      continue
    }
    if (!r.minVersion) continue
    const output = versionOutput(path, r.minVersion.args)
    if (versionAtLeast(output, r.minVersion.version)) continue
    const found = foundVersion(output)
    missing.push({
      program: r.program,
      package: r.package,
      needs: r.minVersion.version,
      ...(found ? { found } : {}),
    })
  }
  return missing
}

function foundVersion(output: string): string | null {
  return /\d+\.\d+[0-9A-Za-z.-]*/.exec(output)?.[0] ?? null
}

function versionAtLeast(output: string, wanted: string): boolean {
  const found = /(\d+)\.(\d+)/.exec(output)
  const [major, minor] = wanted.split('.').map(Number)
  if (!found) return false
  const [have, haveMinor] = [Number(found[1]), Number(found[2])]
  return have > major || (have === major && haveMinor >= minor)
}

const versionOutputs = new Map<string, string>()

function versionKey(path: string, args: string[]): string | null {
  try {
    return [path, statSync(path).mtimeMs, ...args].join('\0')
  } catch {
    return null
  }
}

function versionOutput(path: string, args: string[]): string {
  const key = versionKey(path, args)
  const cached = key === null ? undefined : versionOutputs.get(key)
  if (cached !== undefined) return cached
  let output = ''
  try {
    output = execFileSync(path, args, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {}
  if (key !== null) versionOutputs.set(key, output)
  return output
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
