import { constants, accessSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { PRODUCT_NAME } from '../../shared/product'
import {
  DEFAULT_SWITCHES,
  type ResolvedSandbox,
  type SandboxFixedPolicy,
  type SandboxFolderReason,
  type SandboxSwitches,
} from '../../shared/sandbox'
import { OLD_PRODUCT_NAME } from '../userDirs'

export interface SandboxPaths {
  home: string
  workDir: string
  tmpDir: string
  dataDirs: string[]
  runtimeDir?: string
  socketPath: string
  runtimeReads: string[]
  agentSockets?: string[]
  containerSockets?: string[]
  tmpRoot?: string
  srtVendorDir?: string
  keptSocketPath?: string
}

export type SandboxBasePaths = Omit<SandboxPaths, 'workDir' | 'tmpDir'>

export const SSH_AGENT_SOCKET_NAME = 'a.sock'

export const AGENT_DATA_DIRS = ['.claude', '.codex']

export const AGENT_PROTECTED_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks',
  '.claude/plugins',
  '.claude/CLAUDE.md',
  '.codex/config.toml',
  '.codex/hooks.json',
  '.codex/AGENTS.md',
]

const GIT_CONFIG_FILE = '.git/config'
export const WORKDIR_PROTECTED_FILES = ['.envrc', '.git/hooks', GIT_CONFIG_FILE]
export const WORKDIR_HIDDEN_FILES = [
  `.${PRODUCT_NAME}/vault.json`,
  `.${OLD_PRODUCT_NAME}/vault.json`,
]
export const HOME_HIDDEN_FILES = ['.cargo/credentials.toml', '.cargo/credentials']

export const CONTAINER_SOCKETS = [
  '/run/docker.sock',
  '/var/run/docker.sock',
  '/run/containerd/containerd.sock',
  '/run/podman/podman.sock',
  '/run/crio/crio.sock',
]

function canConnect(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function reachableContainerSockets(
  reachable: (path: string) => boolean = canConnect,
  resolve: (path: string) => string = realpathSync,
): string[] {
  const found = new Set<string>()
  for (const candidate of CONTAINER_SOCKETS) {
    if (!reachable(candidate)) continue
    try {
      found.add(resolve(candidate))
    } catch {
      found.add(candidate)
    }
  }
  return [...found]
}

export function srtVendorDir(appPath: string): string {
  return join(
    appPath.replace(/\.asar$/, '.asar.unpacked'),
    'node_modules',
    '@anthropic-ai',
    'sandbox-runtime',
    'vendor',
  )
}

function vendoredBinaries(
  vendorDir: string | undefined,
  platform: NodeJS.Platform,
  arch: string,
): Partial<Pick<SandboxRuntimeConfig, 'javaAgentJarPath' | 'seccomp'>> {
  if (!vendorDir) return {}
  return {
    javaAgentJarPath: join(vendorDir, 'java-proxy-agent', 'srt-proxy-agent.jar'),
    ...(platform === 'linux' && (arch === 'x64' || arch === 'arm64')
      ? { seccomp: { applyPath: join(vendorDir, 'seccomp', arch, 'apply-seccomp') } }
      : {}),
  }
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function overlaps(path: string, other: string): boolean {
  return within(path, other) || within(other, path)
}

export function touches(path: string, guarded: readonly string[]): boolean {
  const real = realPath(path)
  return guarded.some((g) => {
    const realGuarded = realPath(g)
    return overlaps(path, g) || overlaps(real, realGuarded)
  })
}

export function protectedPaths(paths: SandboxBasePaths): string[] {
  return [
    ...paths.dataDirs,
    ...(paths.agentSockets ?? []).map((sock) => dirname(sock)),
    ...(paths.containerSockets ?? []),
    ...(paths.runtimeDir ? [paths.runtimeDir] : []),
    ...(paths.tmpRoot ? [paths.tmpRoot] : []),
  ]
}

export function protectedFiles(paths: SandboxBasePaths, workDir?: string): string[] {
  return [
    ...AGENT_PROTECTED_FILES.map((f) => join(paths.home, f)),
    ...(workDir
      ? [...WORKDIR_PROTECTED_FILES, ...WORKDIR_HIDDEN_FILES].map((f) => join(workDir, f))
      : []),
  ]
}

export function folderProblem(
  workDir: string,
  paths: { home: string; dataDirs: readonly string[] },
): SandboxFolderReason | null {
  const folder = realPath(workDir)
  const home = realPath(paths.home)
  if (within(home, folder)) return within(folder, home) ? 'home' : 'above-home'
  return paths.dataDirs.some((dir) => overlaps(folder, realPath(dir))) ? 'ostia-data' : null
}

const SECCOMP_ARCHS = ['x64', 'arm64']

export function canBlockSockets(platform: NodeJS.Platform, arch: string): boolean {
  return platform === 'darwin' || (platform === 'linux' && SECCOMP_ARCHS.includes(arch))
}

export function fixedPolicy(
  paths: SandboxBasePaths,
  workspace: { workDir: string; tmpDir: string } | null,
  switches: Pick<SandboxSwitches, 'gitConfig'>,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SandboxFixedPolicy {
  const { home } = paths
  const agentDirs = AGENT_DATA_DIRS.map((d) => join(home, d))
  const hiddenFiles = workspace ? WORKDIR_HIDDEN_FILES.map((f) => join(workspace.workDir, f)) : []
  const hiddenSockets = [
    ...(paths.agentSockets ?? []).map((sock) => dirname(sock)),
    ...(paths.containerSockets ?? []),
  ]
  const guardedInWorkDir = WORKDIR_PROTECTED_FILES.filter(
    (f) => !(switches.gitConfig && f === GIT_CONFIG_FILE),
  )
  return {
    hidden: [
      home,
      ...paths.dataDirs,
      ...HOME_HIDDEN_FILES.map((f) => join(home, f)),
      ...hiddenFiles,
      ...hiddenSockets,
      ...(paths.runtimeDir ? [paths.runtimeDir] : []),
      ...(paths.tmpRoot ? [paths.tmpRoot] : []),
    ],
    readable: [
      ...(workspace ? [workspace.workDir, workspace.tmpDir] : []),
      paths.socketPath,
      ...agentDirs,
      ...paths.runtimeReads,
    ],
    writable: [...(workspace ? [workspace.workDir, workspace.tmpDir] : []), ...agentDirs],
    readOnly: [
      ...AGENT_PROTECTED_FILES.map((f) => join(home, f)),
      ...(workspace ? guardedInWorkDir.map((f) => join(workspace.workDir, f)) : []),
      ...hiddenFiles,
    ],
    hiddenSockets,
    socketBlocking: canBlockSockets(platform, arch),
  }
}

type SrtFilesystem = Omit<
  SandboxRuntimeConfig['filesystem'],
  'denyRead' | 'allowRead' | 'allowWrite' | 'denyWrite'
> & { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] }

export type SrtConfig = Omit<SandboxRuntimeConfig, 'filesystem'> & { filesystem: SrtFilesystem }

export type SrtPolicy = Pick<ResolvedSandbox, 'allowRead' | 'domains'> &
  Partial<Omit<ResolvedSandbox, 'allowRead' | 'domains' | 'portsPolicy'>>

export function buildSrtConfig(
  policy: SrtPolicy,
  paths: SandboxPaths,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SrtConfig {
  const { home, workDir, tmpDir } = paths
  const switches = { ...DEFAULT_SWITCHES, ...policy.switches }
  const fixed = fixedPolicy(paths, { workDir, tmpDir }, switches, platform, arch)
  const guarded = protectedPaths(paths)
  const expand = (list: readonly string[] = []): string[] => list.map((p) => expandHome(p, home))
  const denyRead = expand(policy.denyRead)
  const hiddenByHuman = (path: string): boolean => denyRead.some((d) => within(path, d))
  const opened = (list?: readonly string[]): string[] =>
    expand(list).filter((p) => !touches(p, guarded) && !hiddenByHuman(p))
  const agentDirs = AGENT_DATA_DIRS.map((d) => join(home, d)).filter((d) => !hiddenByHuman(d))
  const allowWrite = opened(policy.allowWrite)
  const isMac = platform === 'darwin'
  const sockets = switches.unixSockets
  return {
    network: {
      allowedDomains: policy.domains,
      deniedDomains: policy.deniedDomains ?? [],
      strictAllowlist: switches.strictDomains,
      ...(isMac
        ? {
            allowUnixSockets: sockets
              ? [
                  paths.socketPath,
                  ...(paths.keptSocketPath ? [paths.keptSocketPath] : []),
                  join(tmpDir, SSH_AGENT_SOCKET_NAME),
                  ...expand(policy.allowSockets).filter((p) => !touches(p, guarded)),
                ]
              : [],
            allowLocalBinding: true,
          }
        : { allowAllUnixSockets: sockets, allowLocalBinding: false }),
    },
    filesystem: {
      denyRead: [...new Set([...fixed.hidden, ...denyRead])],
      allowRead: [
        ...new Set([
          workDir,
          tmpDir,
          paths.socketPath,
          ...(paths.keptSocketPath ? [paths.keptSocketPath] : []),
          ...agentDirs,
          ...paths.runtimeReads,
          ...opened(policy.allowRead),
          ...allowWrite,
        ]),
      ],
      allowWrite: [...new Set([workDir, tmpDir, ...agentDirs, ...allowWrite])],
      denyWrite: [...new Set([...fixed.readOnly, ...expand(policy.denyWrite)])],
      allowGitConfig: switches.gitConfig,
    },
    ...(isMac ? { allowPty: true } : {}),
    ...vendoredBinaries(paths.srtVendorDir, platform, arch),
  }
}

export function runtimeReadsFor(input: {
  integrationDir: string
  stateFile: string
  appPath: string
  execPath: string
}): string[] {
  return [input.integrationDir, dirname(input.stateFile), input.appPath, dirname(input.execPath)]
}
