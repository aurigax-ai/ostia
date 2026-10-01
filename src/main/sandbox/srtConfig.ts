import { constants, accessSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { ResolvedSandbox } from '../../shared/sandbox'

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
}

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

export const WORKDIR_PROTECTED_FILES = ['.envrc', '.git/hooks', '.git/config']
export const WORKDIR_HIDDEN_FILES = ['.pine/vault.json']

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
): Partial<SandboxRuntimeConfig> {
  if (!vendorDir) return {}
  return {
    javaAgentJarPath: join(vendorDir, 'java-proxy-agent', 'srt-proxy-agent.jar'),
    ...(platform === 'linux' && (arch === 'x64' || arch === 'arm64')
      ? { seccomp: { applyPath: join(vendorDir, 'seccomp', arch, 'apply-seccomp') } }
      : {}),
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export function buildSrtConfig(
  policy: Omit<ResolvedSandbox, 'portsPolicy'>,
  paths: SandboxPaths,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SandboxRuntimeConfig {
  const { home, workDir } = paths
  const agentDirs = AGENT_DATA_DIRS.map((d) => join(home, d))
  const hidden = WORKDIR_HIDDEN_FILES.map((f) => join(workDir, f))
  const agentSocketDirs = (paths.agentSockets ?? []).map((sock) => dirname(sock))
  const denyRead = [
    home,
    ...paths.dataDirs,
    ...hidden,
    ...agentSocketDirs,
    ...(paths.containerSockets ?? []),
  ]
  if (paths.runtimeDir) denyRead.push(paths.runtimeDir)
  if (paths.tmpRoot) denyRead.push(paths.tmpRoot)
  const insideData = (path: string): boolean =>
    paths.dataDirs.some(
      (dir) => path === dir || path.startsWith(`${dir}/`) || dir.startsWith(`${path}/`),
    )
  const allowRead = [
    workDir,
    paths.tmpDir,
    paths.socketPath,
    ...agentDirs,
    ...paths.runtimeReads,
    ...policy.allowRead.map((p) => expandHome(p, home)).filter((p) => !insideData(p)),
  ]
  const isMac = platform === 'darwin'
  return {
    network: {
      allowedDomains: policy.domains,
      deniedDomains: [],
      ...(isMac
        ? { allowUnixSockets: [paths.socketPath], allowLocalBinding: true }
        : { allowAllUnixSockets: true, allowLocalBinding: false }),
    },
    filesystem: {
      denyRead,
      allowRead: [...new Set(allowRead)],
      allowWrite: [workDir, paths.tmpDir, ...agentDirs],
      denyWrite: [
        ...AGENT_PROTECTED_FILES.map((f) => join(home, f)),
        ...WORKDIR_PROTECTED_FILES.map((f) => join(workDir, f)),
        ...hidden,
      ],
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
