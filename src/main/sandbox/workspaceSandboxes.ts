import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { PackageRef } from '../../shared/packages'
import {
  type ResolvedSandbox,
  type SandboxGlobals,
  type WorkspaceSandbox,
  resolvePackages,
  resolveSandbox,
} from '../../shared/sandbox'
import { SandboxHost, SandboxHostError } from './hostClient'
import type { PackageBlockReason, PackagePolicy } from './packagePolicy'
import { type SandboxPaths, buildSrtConfig } from './srtConfig'
import type { SandboxStore } from './store'

export interface WorkspaceSandboxesDeps {
  store: SandboxStore
  globals: () => SandboxGlobals
  basePaths: () => Omit<SandboxPaths, 'workDir' | 'tmpDir'>
  workDir: (workspaceId: string) => string | undefined
  tmpRoot: string
  nodePath: string
  hostScript: string
  hostEnv?: NodeJS.ProcessEnv
  onAsk: (workspaceId: string, host: string, port: number | undefined) => Promise<boolean>
  onPackageBlocked?: (workspaceId: string, pkg: PackageRef, reason: PackageBlockReason) => void
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

  constructor(private readonly deps: WorkspaceSandboxesDeps) {}

  isEnabled(workspaceId: string): boolean {
    return this.deps.store.isCorrupt || this.deps.store.get(workspaceId).enabled
  }

  settings(workspaceId: string): WorkspaceSandbox {
    return this.deps.store.get(workspaceId)
  }

  update(
    workspaceId: string,
    change: (current: WorkspaceSandbox) => WorkspaceSandbox,
  ): WorkspaceSandbox {
    const next = this.deps.store.set(workspaceId, change(this.deps.store.get(workspaceId)))
    void this.refresh(workspaceId)
    return next
  }

  resolved(workspaceId: string): ResolvedSandbox {
    return resolveSandbox(this.deps.globals(), this.deps.store.get(workspaceId), [
      ...(this.sessionDomains.get(workspaceId) ?? []),
    ])
  }

  packagePolicy(workspaceId: string): PackagePolicy {
    const resolved = resolvePackages(this.deps.globals(), this.deps.store.get(workspaceId))
    return {
      ...resolved,
      allowances: [...resolved.allowances, ...(this.sessionPackages.get(workspaceId) ?? [])],
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
    const set = this.sessionPackages.get(workspaceId) ?? new Set<string>()
    set.add(versionKey)
    this.sessionPackages.set(workspaceId, set)
    void this.refresh(workspaceId)
  }

  tmpDir(workspaceId: string): string {
    return join(this.deps.tmpRoot, workspaceId)
  }

  config(workspaceId: string): SandboxRuntimeConfig {
    const workDir = this.deps.workDir(workspaceId)
    if (!workDir) throw new SandboxUnavailableError('the workspace folder is not known yet')
    const tmpDir = this.tmpDir(workspaceId)
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
    const policy = resolveSandbox(this.deps.globals(), this.deps.store.get(workspaceId), [
      ...(this.sessionDomains.get(workspaceId) ?? []),
    ])
    return buildSrtConfig(policy, {
      ...this.deps.basePaths(),
      workDir,
      tmpDir,
      tmpRoot: this.deps.tmpRoot,
    })
  }

  async wrap(
    workspaceId: string,
    command: string,
    binShell: string,
    extraWrites: string[] = [],
  ): Promise<string> {
    if (this.deps.store.isCorrupt) {
      throw new SandboxUnavailableError(
        'the sandbox settings file is unreadable; reset it in Settings › Sandbox',
      )
    }
    const host = await this.host(workspaceId)
    try {
      if (extraWrites.length === 0) return await host.wrap(command, binShell)
      const { filesystem } = this.config(workspaceId)
      return await host.wrap(command, binShell, {
        filesystem: { ...filesystem, allowWrite: [...filesystem.allowWrite, ...extraWrites] },
      })
    } catch (err) {
      throw new SandboxUnavailableError(err instanceof Error ? err.message : String(err))
    }
  }

  allowUntilRestart(workspaceId: string, domain: string): void {
    const set = this.sessionDomains.get(workspaceId) ?? new Set<string>()
    set.add(domain)
    this.sessionDomains.set(workspaceId, set)
    void this.refresh(workspaceId)
  }

  async refresh(workspaceId: string): Promise<void> {
    const pending = this.hosts.get(workspaceId)
    if (!pending) return
    const host = await pending.catch(() => null)
    if (host?.alive) await host.update(this.config(workspaceId), this.packagePolicy(workspaceId))
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
    this.sessionDomains.delete(workspaceId)
    this.sessionPackages.delete(workspaceId)
    this.deps.store.remove(workspaceId)
    rmSync(this.tmpDir(workspaceId), { recursive: true, force: true })
  }

  refreshAll(): void {
    for (const id of [...this.hosts.keys()]) void this.refresh(id)
  }

  clearTmp(): void {
    rmSync(this.deps.tmpRoot, { recursive: true, force: true })
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
      env: this.deps.hostEnv,
      onAsk: (h, port) => this.deps.onAsk(workspaceId, h, port),
      onPackageBlocked: (pkg, reason) => this.deps.onPackageBlocked?.(workspaceId, pkg, reason),
      onExit: () => {
        if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
      },
    })
    const started = (async () => {
      await host.start(this.config(workspaceId), this.packagePolicy(workspaceId))
      return host
    })().catch((err: unknown) => {
      if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
      host.stop()
      if (err instanceof SandboxHostError)
        throw new SandboxUnavailableError(err.message, err.missing)
      throw err
    })
    this.hosts.set(workspaceId, started)
    return started
  }
}
