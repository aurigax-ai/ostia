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

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

export function buildSrtConfig(
  policy: Omit<ResolvedSandbox, 'portsPolicy'>,
  paths: SandboxPaths,
  platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig {
  const { home, workDir } = paths
  const agentDirs = AGENT_DATA_DIRS.map((d) => join(home, d))
  const hidden = WORKDIR_HIDDEN_FILES.map((f) => join(workDir, f))
  const agentSocketDirs = (paths.agentSockets ?? []).map((sock) => dirname(sock))
  const denyRead = [home, ...paths.dataDirs, ...hidden, ...agentSocketDirs]
  if (paths.runtimeDir) denyRead.push(paths.runtimeDir)
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
