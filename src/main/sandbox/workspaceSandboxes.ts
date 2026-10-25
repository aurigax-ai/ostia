import { hash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import {
  emptyWorkspaceSandbox,
  type ResolvedSandbox,
  resolvePackages,
  resolveSandbox,
  type SandboxFixedPolicy,
  type SandboxFolderProblem,
  type SandboxGlobals,
  type SandboxMergeRefusal,
  sandboxMergeRefusal,
  type WorkspaceSandbox,
} from '../../shared/sandbox/sandbox'
import { expandHome, isInsidePath } from '../platform/pathGuard'
import type { PackageBlockReason, PackagePolicy } from '../sandboxPackages/packagePolicy'
import type { PackageRef } from '../sandboxPackages/packages'
import { hookLinkTargets } from './hookLinks'
import { SandboxUnavailableError } from './hostClient'
import type { SandboxPathEnv } from './pathChecks'
import { ensurePluginsFarm, linkPluginsFarm } from './pluginsFarm'
import { type KeptSandboxHosts, SandboxHosts } from './sandboxHosts'
import { SandboxTmpDirs } from './sandboxTmp'
import {
  buildSrtConfig,
  fixedPolicy,
  folderProblem,
  protectedFiles,
  protectedPaths,
  realPath,
  type SandboxPaths,
  type SrtConfig,
  SSH_AGENT_SOCKET_NAME,
} from './srtConfig'
import type { SandboxStore } from './store'
import type { WriteRefusal } from './violations'
import type { SandboxReadRules } from './visibility'

export interface WorkspaceSandboxesDeps {
  store: SandboxStore
  globals: () => SandboxGlobals
  basePaths: () => Omit<SandboxPaths, 'workDir' | 'tmpDir'>
  workDir: (workspaceId: string) => string | undefined
  tmpRoot: string
  pid?: number
  processAlive?: (pid: number) => boolean
  nodePath: string
  hostScript: string
  hostEnv?: NodeJS.ProcessEnv
  onAsk: (workspaceId: string, host: string, port: number | undefined) => Promise<boolean>
  onPackageBlocked?: (workspaceId: string, pkg: PackageRef, reason: PackageBlockReason) => void
  onViolations?: (workspaceId: string, lines: string[]) => void
  kept?: KeptSandboxHosts
}

const KERNEL_MOUNTS = ['/dev', '/proc']
const FOLDER_PROBLEM_TEXT: Record<SandboxFolderProblem['reason'], string> = {
  home: 'is your home folder',
  'above-home': 'contains your home folder',
  'ostia-data': `holds ${PRODUCT_DISPLAY_NAME}'s own data`,
}

function folderProblemMessage(problem: SandboxFolderProblem): string {
  return `${problem.folder} ${FOLDER_PROBLEM_TEXT[problem.reason]}, so a sandbox cannot confine it; open a project folder instead`
}

function addFor(map: Map<string, Set<string>>, owner: string, values: Iterable<string>): void {
  const set = map.get(owner) ?? new Set<string>()
  for (const value of values) set.add(value)
  map.set(owner, set)
}

export class WorkspaceSandboxes {
  private readonly sessionDomains = new Map<string, Set<string>>()
  private readonly sessionPackages = new Map<string, Set<string>>()
  private readonly mergedInto = new Map<string, string>()
  private readonly paneWrites = new Map<string, Set<string>>()
  private readonly toldAboutHome = new Set<string>()
  readonly tmp: SandboxTmpDirs
  readonly hosts: SandboxHosts

  constructor(private readonly deps: WorkspaceSandboxesDeps) {
    this.tmp = new SandboxTmpDirs({
      tmpRoot: deps.tmpRoot,
      pid: deps.pid,
      processAlive: deps.processAlive,
      kept: deps.kept,
    })
    this.hosts = new SandboxHosts({
      nodePath: deps.nodePath,
      hostScript: deps.hostScript,
      hostEnv: deps.hostEnv,
      onAsk: deps.onAsk,
      onPackageBlocked: deps.onPackageBlocked,
      onViolations: deps.onViolations,
      kept: deps.kept,
      mergedInto: this.mergedInto,
      owner: (workspaceId) => this.owner(workspaceId),
      tmpDir: (workspaceId) => this.tmp.tmpDir(workspaceId),
      adoptKeptTmp: (workspaceId, dir) => this.tmp.adoptKeptTmp(workspaceId, dir),
      config: (workspaceId) => this.config(workspaceId),
      packagePolicy: (workspaceId) => this.packagePolicy(workspaceId),
      folderProblem: (workspaceId) => this.folderProblem(workspaceId),
    })
  }

  owner(workspaceId: string): string {
    return this.mergedInto.get(workspaceId) ?? workspaceId
  }

  isEnabled(workspaceId: string): boolean {
    return this.deps.store.isCorrupt || this.deps.store.get(this.owner(workspaceId)).enabled
  }

  settings(workspaceId: string): WorkspaceSandbox {
    return this.deps.store.get(this.owner(workspaceId))
  }

  mergeRefusal(sourceId: string, targetId: string): SandboxMergeRefusal | null {
    return sandboxMergeRefusal(
      { ...this.settings(sourceId), enabled: this.isEnabled(sourceId) },
      { ...this.settings(targetId), enabled: this.isEnabled(targetId) },
    )
  }

  merge(sourceId: string, targetId: string): void {
    const owner = this.owner(targetId)
    for (const [id, into] of this.mergedInto) if (into === sourceId) this.mergedInto.set(id, owner)
    this.mergedInto.set(sourceId, owner)
    this.sessionDomains.delete(sourceId)
    this.sessionPackages.delete(sourceId)
    this.deps.store.remove(sourceId)
    void this.hosts.refresh(owner)
  }

  update(
    workspaceId: string,
    change: (current: WorkspaceSandbox) => WorkspaceSandbox,
  ): WorkspaceSandbox {
    const owner = this.owner(workspaceId)
    const next = this.deps.store.set(owner, change(this.deps.store.get(owner)))
    void this.hosts.refresh(owner)
    return next
  }

  workDir(workspaceId: string): string | undefined {
    const folder = this.deps.workDir(this.owner(workspaceId))
    return folder === undefined ? undefined : expandHome(folder, this.deps.basePaths().home)
  }

  private basePaths(): Omit<SandboxPaths, 'workDir' | 'tmpDir'> {
    return { ...this.deps.basePaths(), tmpRoot: this.deps.tmpRoot }
  }

  private pluginsSource(): string {
    return join(this.deps.basePaths().home, '.claude', 'plugins')
  }

  folderProblem(workspaceId: string): SandboxFolderProblem | null {
    const folder = this.workDir(workspaceId)
    if (!folder) return null
    const reason = folderProblem(folder, this.basePaths())
    return reason ? { folder, reason } : null
  }

  pathEnv(workspaceId?: string): SandboxPathEnv {
    const base = this.basePaths()
    const workDir = workspaceId ? this.workDir(workspaceId) : undefined
    return {
      home: base.home,
      dataDirs: base.dataDirs,
      protectedDirs: protectedPaths(base),
      protectedFiles: protectedFiles(base, workDir),
    }
  }

  fixedPolicy(workspaceId?: string): SandboxFixedPolicy {
    const workDir = workspaceId ? this.workDir(workspaceId) : undefined
    const switches = workspaceId
      ? this.resolved(workspaceId).switches
      : resolveSandbox(this.deps.globals(), emptyWorkspaceSandbox()).switches
    return fixedPolicy(
      this.basePaths(),
      workspaceId && workDir
        ? {
            workDir,
            tmpDir: this.tmp.tmpDir(workspaceId),
            pluginsDir: this.tmp.pluginsDir(workspaceId),
          }
        : null,
      switches,
    )
  }

  wrapStamp(workspaceId: string): string | null {
    try {
      const { network, filesystem } = this.config(workspaceId)
      const plumbing = new Set(this.plumbingPaths(workspaceId))
      const policy = (list: readonly string[] | undefined): string[] | undefined =>
        list?.filter((path) => !plumbing.has(path))
      const baked = {
        filesystem: {
          ...filesystem,
          denyRead: policy(filesystem.denyRead),
          allowRead: policy(filesystem.allowRead),
          allowWrite: policy(filesystem.allowWrite),
          denyWrite: policy(filesystem.denyWrite),
        },
        allowUnixSockets: policy(network.allowUnixSockets),
        allowAllUnixSockets: network.allowAllUnixSockets,
        allowLocalBinding: network.allowLocalBinding,
        unixSockets: this.resolved(workspaceId).switches.unixSockets,
      }
      return hash('sha256', JSON.stringify(baked)).slice(0, 16)
    } catch {
      return null
    }
  }

  private plumbingPaths(workspaceId: string): string[] {
    const base = this.basePaths()
    const tmpDir = this.tmp.tmpDir(workspaceId)
    const pluginsDir = this.tmp.pluginsDir(workspaceId)
    return [
      base.socketPath,
      ...(base.keptSocketPath ? [base.keptSocketPath] : []),
      ...base.runtimeReads,
      ...base.dataDirs,
      ...(base.agentSockets ?? []).map((sock) => dirname(sock)),
      ...(base.runtimeDir ? [base.runtimeDir] : []),
      ...(base.tmpRoot ? [base.tmpRoot] : []),
      tmpDir,
      pluginsDir,
      join(tmpDir, SSH_AGENT_SOCKET_NAME),
    ]
  }

  writeRefusal(workspaceId: string, path: string): WriteRefusal | null {
    if (KERNEL_MOUNTS.some((mount) => isInsidePath(mount, path))) return null
    try {
      const { filesystem } = this.config(workspaceId)
      const extra = this.paneWrites.get(this.owner(workspaceId)) ?? []
      const real = realPath(path)
      const under = (list: readonly string[]): boolean =>
        list.some((entry) => isInsidePath(entry, path) || isInsidePath(realPath(entry), real))
      if (under(filesystem.denyWrite)) return 'read-only'
      return under([...filesystem.allowWrite, ...extra]) ? null : 'outside'
    } catch {
      return 'outside'
    }
  }

  resolved(workspaceId: string): ResolvedSandbox {
    const owner = this.owner(workspaceId)
    return resolveSandbox(this.deps.globals(), this.deps.store.get(owner), [
      ...(this.sessionDomains.get(owner) ?? []),
    ])
  }

  packagePolicy(workspaceId: string): PackagePolicy {
    const owner = this.owner(workspaceId)
    const resolved = resolvePackages(this.deps.globals(), this.deps.store.get(owner))
    return {
      ...resolved,
      allowances: [...resolved.allowances, ...(this.sessionPackages.get(owner) ?? [])],
    }
  }

  allowPackage(workspaceId: string, versionKey: string, lasting: boolean): void {
    if (lasting) {
      this.update(workspaceId, (current) => {
        const allowances = current.packages?.allowances ?? []
        return allowances.includes(versionKey)
          ? current
          : {
              ...current,
              packages: { ...current.packages, allowances: [...allowances, versionKey] },
            }
      })
      return
    }
    const owner = this.owner(workspaceId)
    addFor(this.sessionPackages, owner, [versionKey])
    void this.hosts.refresh(owner)
  }

  claimHomeNotice(workspaceId: string): boolean {
    const owner = this.owner(workspaceId)
    if (this.toldAboutHome.has(owner)) return false
    this.toldAboutHome.add(owner)
    return true
  }

  config(workspaceId: string): SrtConfig {
    const workDir = this.workDir(workspaceId)
    if (!workDir) throw new SandboxUnavailableError('the workspace folder is not known yet')
    const problem = this.folderProblem(workspaceId)
    if (problem) throw new SandboxUnavailableError(folderProblemMessage(problem))
    const tmpDir = this.tmp.tmpDir(workspaceId)
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
    const pluginsDir = this.tmp.pluginsDir(workspaceId)
    ensurePluginsFarm(pluginsDir, this.tmp.pluginsData(workspaceId))
    const base = this.basePaths()
    return buildSrtConfig(this.resolved(workspaceId), {
      ...base,
      workDir,
      tmpDir,
      pluginsDir,
      hookLinks: hookLinkTargets(base.home),
    })
  }

  readRules(workspaceId: string): SandboxReadRules {
    try {
      const { denyRead, allowRead } = this.config(workspaceId).filesystem
      return { denyRead, allowRead }
    } catch {
      return { denyRead: ['/'], allowRead: [] }
    }
  }

  async wrap(
    workspaceId: string,
    command: string,
    binShell: string,
    extraWrites: string[] = [],
    extraReads: string[] = [],
  ): Promise<string> {
    if (this.deps.store.isCorrupt) {
      throw new SandboxUnavailableError(
        'the sandbox settings file is unreadable; reset it in Settings › Sandbox',
      )
    }
    const problem = this.folderProblem(workspaceId)
    if (problem) throw new SandboxUnavailableError(folderProblemMessage(problem))
    linkPluginsFarm(
      this.tmp.pluginsDir(workspaceId),
      this.tmp.pluginsData(workspaceId),
      this.pluginsSource(),
    )
    const host = await this.hosts.host(workspaceId)
    try {
      if (extraWrites.length === 0 && extraReads.length === 0) {
        return await host.wrap(command, binShell)
      }
      if (extraWrites.length > 0) {
        addFor(this.paneWrites, this.owner(workspaceId), extraWrites)
      }
      const { filesystem } = this.config(workspaceId)
      return await host.wrap(command, binShell, {
        filesystem: {
          ...filesystem,
          allowWrite: [...filesystem.allowWrite, ...extraWrites],
          allowRead: [...(filesystem.allowRead ?? []), ...extraReads],
        },
      })
    } catch (err) {
      throw new SandboxUnavailableError(err instanceof Error ? err.message : String(err))
    }
  }

  allowUntilRestart(workspaceId: string, domain: string): void {
    const owner = this.owner(workspaceId)
    addFor(this.sessionDomains, owner, [domain])
    void this.hosts.refresh(owner)
  }

  forget(workspaceId: string): void {
    this.hosts.stop(workspaceId)
    this.mergedInto.delete(workspaceId)
    this.sessionDomains.delete(workspaceId)
    this.sessionPackages.delete(workspaceId)
    this.paneWrites.delete(workspaceId)
    this.toldAboutHome.delete(workspaceId)
    this.deps.store.remove(workspaceId)
    this.tmp.remove(workspaceId)
  }
}
