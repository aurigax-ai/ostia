import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { PackageRef } from '../../shared/packages'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import {
  type ResolvedSandbox,
  type SandboxFixedPolicy,
  type SandboxFolderProblem,
  type SandboxGlobals,
  type SandboxMergeRefusal,
  type WorkspaceSandbox,
  emptyWorkspaceSandbox,
  resolvePackages,
  resolveSandbox,
  sandboxMergeRefusal,
} from '../../shared/sandbox'
import { processAlive } from '../processAlive'
import { SandboxHost, SandboxHostError } from './hostClient'
import type { PackageBlockReason, PackagePolicy } from './packagePolicy'
import type { SandboxPathEnv } from './pathChecks'
import {
  SSH_AGENT_SOCKET_NAME,
  type SandboxPaths,
  buildSrtConfig,
  expandHome,
  fixedPolicy,
  folderProblem,
  protectedFiles,
  protectedPaths,
  realPath,
  within,
} from './srtConfig'
import type { SandboxStore } from './store'
import type { WriteRefusal } from './violations'

export interface KeptHostSpawn {
  file: string
  args: string[]
  env: Record<string, string>
  channel: string
  tmpDir: string
}

export interface KeptSandboxHosts {
  enabled(): boolean
  tmpRoot: string
  channel(workspaceId: string): string
  claim(workspaceId: string): { channel: string; tmpDir: string } | undefined
  spawn(workspaceId: string, spec: KeptHostSpawn): Promise<void>
  stop(workspaceId: string): void
}

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

const HOST_LISTEN_FLAG = '--listen'
const CHANNEL_WAIT_MS = 10_000
const CHANNEL_POLL_MS = 50

async function waitForChannel(path: string): Promise<void> {
  const end = Date.now() + CHANNEL_WAIT_MS
  while (!existsSync(path)) {
    if (Date.now() > end) throw new SandboxHostError('the sandbox host did not start listening')
    await new Promise((resolve) => setTimeout(resolve, CHANNEL_POLL_MS))
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

const KERNEL_MOUNTS = ['/dev', '/proc']
const INSTANCE_TMP_NAME = /^\d+$/

const FOLDER_PROBLEM_TEXT: Record<SandboxFolderProblem['reason'], string> = {
  home: 'is your home folder',
  'above-home': 'contains your home folder',
  'ostia-data': `holds ${PRODUCT_DISPLAY_NAME}'s own data`,
}

export function folderProblemMessage(problem: SandboxFolderProblem): string {
  return `${problem.folder} ${FOLDER_PROBLEM_TEXT[problem.reason]}, so a sandbox cannot confine it; open a project folder instead`
}

function instanceTmpNames(tmpRoot: string): string[] {
  try {
    return readdirSync(tmpRoot).filter((name) => INSTANCE_TMP_NAME.test(name))
  } catch {
    return []
  }
}

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message)
  }
}

export class WorkspaceSandboxes {
  private readonly hosts = new Map<string, Promise<SandboxHost>>()
  private readonly sessionDomains = new Map<string, Set<string>>()
  private readonly sessionPackages = new Map<string, Set<string>>()
  private readonly mergedInto = new Map<string, string>()
  private readonly paneWrites = new Map<string, Set<string>>()
  private readonly toldAboutHome = new Set<string>()
  private readonly tmpDirs = new Map<string, string>()
  private readonly keptHosts = new Set<string>()

  private readonly pid: number
  private readonly instanceTmp: string

  constructor(private readonly deps: WorkspaceSandboxesDeps) {
    this.pid = deps.pid ?? process.pid
    this.instanceTmp = join(deps.tmpRoot, String(this.pid))
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
    void this.refresh(owner)
  }

  update(
    workspaceId: string,
    change: (current: WorkspaceSandbox) => WorkspaceSandbox,
  ): WorkspaceSandbox {
    const owner = this.owner(workspaceId)
    const next = this.deps.store.set(owner, change(this.deps.store.get(owner)))
    void this.refresh(owner)
    return next
  }

  workDir(workspaceId: string): string | undefined {
    const folder = this.deps.workDir(this.owner(workspaceId))
    return folder === undefined ? undefined : expandHome(folder, this.deps.basePaths().home)
  }

  private basePaths(): Omit<SandboxPaths, 'workDir' | 'tmpDir'> {
    return { ...this.deps.basePaths(), tmpRoot: this.deps.tmpRoot }
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
      workspaceId && workDir ? { workDir, tmpDir: this.tmpDir(workspaceId) } : null,
      switches,
    )
  }

  wrapStamp(workspaceId: string): string | null {
    try {
      const { network, filesystem } = this.config(workspaceId)
      const baked = {
        filesystem,
        allowUnixSockets: network.allowUnixSockets,
        allowAllUnixSockets: network.allowAllUnixSockets,
        allowLocalBinding: network.allowLocalBinding,
      }
      return createHash('sha256').update(JSON.stringify(baked)).digest('hex').slice(0, 16)
    } catch {
      return null
    }
  }

  writeRefusal(workspaceId: string, path: string): WriteRefusal | null {
    if (KERNEL_MOUNTS.some((mount) => within(path, mount))) return null
    try {
      const { filesystem } = this.config(workspaceId)
      const extra = this.paneWrites.get(this.owner(workspaceId)) ?? []
      const real = realPath(path)
      const under = (list: readonly string[]): boolean =>
        list.some((entry) => within(path, entry) || within(real, realPath(entry)))
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
    const set = this.sessionPackages.get(owner) ?? new Set<string>()
    set.add(versionKey)
    this.sessionPackages.set(owner, set)
    void this.refresh(owner)
  }

  claimHomeNotice(workspaceId: string): boolean {
    const owner = this.owner(workspaceId)
    if (this.toldAboutHome.has(owner)) return false
    this.toldAboutHome.add(owner)
    return true
  }

  tmpDir(workspaceId: string): string {
    const chosen = this.tmpDirs.get(workspaceId)
    if (chosen) return chosen
    const short = createHash('sha256').update(workspaceId).digest('hex').slice(0, 10)
    const kept = this.deps.kept
    const dir = join(kept?.enabled() ? kept.tmpRoot : this.instanceTmp, short)
    this.tmpDirs.set(workspaceId, dir)
    return dir
  }

  adoptKeptTmp(workspaceId: string, dir: string): void {
    this.tmpDirs.set(workspaceId, dir)
  }

  isKept(workspaceId: string): boolean {
    return this.keptHosts.has(workspaceId)
  }

  sshAgentSocket(workspaceId: string): string {
    return join(this.tmpDir(workspaceId), SSH_AGENT_SOCKET_NAME)
  }

  config(workspaceId: string): SandboxRuntimeConfig {
    const workDir = this.workDir(workspaceId)
    if (!workDir) throw new SandboxUnavailableError('the workspace folder is not known yet')
    const problem = this.folderProblem(workspaceId)
    if (problem) throw new SandboxUnavailableError(folderProblemMessage(problem))
    const tmpDir = this.tmpDir(workspaceId)
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
    return buildSrtConfig(this.resolved(workspaceId), { ...this.basePaths(), workDir, tmpDir })
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
    const host = await this.host(workspaceId)
    try {
      if (extraWrites.length === 0 && extraReads.length === 0) {
        return await host.wrap(command, binShell)
      }
      if (extraWrites.length > 0) {
        const owner = this.owner(workspaceId)
        const seen = this.paneWrites.get(owner) ?? new Set<string>()
        for (const path of extraWrites) seen.add(path)
        this.paneWrites.set(owner, seen)
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
    const set = this.sessionDomains.get(owner) ?? new Set<string>()
    set.add(domain)
    this.sessionDomains.set(owner, set)
    void this.refresh(owner)
  }

  async refresh(workspaceId: string): Promise<void> {
    const owner = this.owner(workspaceId)
    const merged = [...this.mergedInto].filter(([, into]) => into === owner).map(([id]) => id)
    await this.refreshHost(owner)
    for (const id of merged) await this.refreshHost(id).catch(() => undefined)
  }

  private async refreshHost(workspaceId: string): Promise<void> {
    const pending = this.hosts.get(workspaceId)
    if (!pending) return
    const host = await pending.catch(() => null)
    if (!host?.alive || this.folderProblem(workspaceId)) return
    await host.update(this.config(workspaceId), this.packagePolicy(workspaceId))
  }

  async cleanup(workspaceId: string): Promise<void> {
    const host = await this.hosts.get(workspaceId)?.catch(() => null)
    await host?.cleanup().catch(() => undefined)
  }

  stop(workspaceId: string): void {
    const pending = this.hosts.get(workspaceId)
    this.hosts.delete(workspaceId)
    void pending?.then((host) => host.stop()).catch(() => undefined)
  }

  forget(workspaceId: string): void {
    this.stop(workspaceId)
    this.mergedInto.delete(workspaceId)
    this.sessionDomains.delete(workspaceId)
    this.sessionPackages.delete(workspaceId)
    this.paneWrites.delete(workspaceId)
    this.toldAboutHome.delete(workspaceId)
    this.deps.store.remove(workspaceId)
    rmSync(this.tmpDir(workspaceId), { recursive: true, force: true })
    this.tmpDirs.delete(workspaceId)
  }

  refreshAll(): void {
    for (const id of [...this.hosts.keys()]) void this.refresh(id)
  }

  clearTmp(includingKept = true): void {
    rmSync(this.instanceTmp, { recursive: true, force: true })
    if (includingKept && this.deps.kept) {
      rmSync(this.deps.kept.tmpRoot, { recursive: true, force: true })
    }
  }

  sweepKeptTmp(liveWorkspaceIds: readonly string[]): string[] {
    const kept = this.deps.kept
    if (!kept) return []
    const live = new Set(liveWorkspaceIds.map((id) => this.tmpDir(id)))
    const removed: string[] = []
    let names: string[] = []
    try {
      names = readdirSync(kept.tmpRoot)
    } catch {
      return []
    }
    for (const name of names) {
      const dir = join(kept.tmpRoot, name)
      if (live.has(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }

  releaseAll(): void {
    for (const [id, pending] of [...this.hosts]) {
      this.hosts.delete(id)
      const kept = this.keptHosts.has(id)
      void pending.then((host) => (kept ? host.release() : host.stop())).catch(() => undefined)
    }
  }

  sweepTmp(): string[] {
    const alive = this.deps.processAlive ?? processAlive
    const removed: string[] = []
    for (const name of instanceTmpNames(this.deps.tmpRoot)) {
      const pid = Number(name)
      if (pid === this.pid || alive(pid)) continue
      const dir = join(this.deps.tmpRoot, name)
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }

  stopAll(): void {
    for (const id of [...this.hosts.keys()]) this.stop(id)
  }

  private host(workspaceId: string): Promise<SandboxHost> {
    const existing = this.hosts.get(workspaceId)
    if (existing) return existing
    const host = new SandboxHost({
      nodePath: this.deps.nodePath,
      hostScript: this.deps.hostScript,
      env: { ...(this.deps.hostEnv ?? process.env), CLAUDE_CODE_TMPDIR: this.tmpDir(workspaceId) },
      onAsk: (h, port) => this.deps.onAsk(workspaceId, h, port),
      onPackageBlocked: (pkg, reason) => this.deps.onPackageBlocked?.(workspaceId, pkg, reason),
      onViolations: (lines) => this.deps.onViolations?.(workspaceId, lines),
      onExit: () => {
        if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
        this.keptHosts.delete(workspaceId)
      },
    })
    const started = (async () => {
      const kept = this.deps.kept
      const existing = kept?.claim(workspaceId)
      if (existing) {
        this.tmpDirs.set(workspaceId, existing.tmpDir)
        this.keptHosts.add(workspaceId)
        await host.attach(
          existing.channel,
          this.config(workspaceId),
          this.packagePolicy(workspaceId),
          false,
        )
      } else if (kept?.enabled()) {
        const channel = kept.channel(workspaceId)
        const tmpDir = this.tmpDir(workspaceId)
        mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
        rmSync(channel, { force: true })
        await kept.spawn(workspaceId, {
          file: this.deps.nodePath,
          args: [this.deps.hostScript, HOST_LISTEN_FLAG, channel],
          env: {
            ...definedEnv(this.deps.hostEnv ?? process.env),
            CLAUDE_CODE_TMPDIR: tmpDir,
            ELECTRON_RUN_AS_NODE: '1',
          },
          channel,
          tmpDir,
        })
        this.keptHosts.add(workspaceId)
        await waitForChannel(channel)
        await host.attach(channel, this.config(workspaceId), this.packagePolicy(workspaceId), true)
      } else {
        await host.start(this.config(workspaceId), this.packagePolicy(workspaceId))
      }
      return host
    })().catch((err: unknown) => {
      if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
      host.stop()
      if (this.keptHosts.delete(workspaceId)) this.deps.kept?.stop(workspaceId)
      if (err instanceof SandboxHostError)
        throw new SandboxUnavailableError(err.message, err.missing)
      throw err
    })
    this.hosts.set(workspaceId, started)
    return started
  }
}
