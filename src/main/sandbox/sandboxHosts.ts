import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SandboxFolderProblem } from '../../shared/sandbox/sandbox'
import { socketPathLimit } from '../platform/privateTmp'
import type { PackageBlockReason, PackagePolicy } from '../sandboxPackages/packagePolicy'
import type { PackageRef } from '../sandboxPackages/packages'
import { SandboxHost, SandboxUnavailableError } from './hostClient'
import type { SrtConfig } from './srtConfig'

interface KeptHostSpawn {
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

const HOST_LISTEN_FLAG = '--listen'
const CHANNEL_WAIT_MS = 10_000
const CHANNEL_POLL_MS = 50

async function waitForChannel(path: string): Promise<void> {
  const end = Date.now() + CHANNEL_WAIT_MS
  while (!existsSync(path)) {
    if (Date.now() > end)
      throw new SandboxUnavailableError('the sandbox host did not start listening')
    await sleep(CHANNEL_POLL_MS)
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

export interface SandboxHostsDeps {
  nodePath: string
  hostScript: string
  hostEnv?: NodeJS.ProcessEnv
  onAsk: (workspaceId: string, host: string, port: number | undefined) => Promise<boolean>
  onPackageBlocked?: (workspaceId: string, pkg: PackageRef, reason: PackageBlockReason) => void
  onViolations?: (workspaceId: string, lines: string[]) => void
  kept?: KeptSandboxHosts
  mergedInto: ReadonlyMap<string, string>
  owner: (workspaceId: string) => string
  tmpDir: (workspaceId: string) => string
  adoptKeptTmp: (workspaceId: string, dir: string) => void
  config: (workspaceId: string) => SrtConfig
  packagePolicy: (workspaceId: string) => PackagePolicy
  folderProblem: (workspaceId: string) => SandboxFolderProblem | null
  watchLeftBehind?: (workspaceId: string) => () => void
}

export class SandboxHosts {
  private readonly hosts = new Map<string, Promise<SandboxHost>>()
  private readonly keptHosts = new Set<string>()
  private readonly released = new Set<string>()

  constructor(private readonly deps: SandboxHostsDeps) {}

  isKept(workspaceId: string): boolean {
    return this.keptHosts.has(workspaceId)
  }

  async connect(workspaceId: string): Promise<void> {
    await this.host(workspaceId)
  }

  async refresh(workspaceId: string): Promise<void> {
    const owner = this.deps.owner(workspaceId)
    const merged = [...this.deps.mergedInto].filter(([, into]) => into === owner).map(([id]) => id)
    await this.refreshHost(owner)
    for (const id of merged) await this.refreshHost(id).catch(() => undefined)
  }

  private async refreshHost(workspaceId: string): Promise<void> {
    const pending = this.hosts.get(workspaceId)
    if (!pending) return
    const host = await pending.catch(() => null)
    if (!host?.alive || this.deps.folderProblem(workspaceId)) return
    await host.update(this.deps.config(workspaceId), this.deps.packagePolicy(workspaceId))
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

  refreshAll(): void {
    for (const id of [...this.hosts.keys()]) void this.refresh(id)
  }

  releaseAll(): void {
    for (const [id, pending] of [...this.hosts]) {
      this.hosts.delete(id)
      const kept = this.keptHosts.has(id)
      if (kept) this.released.add(id)
      void pending.then((host) => (kept ? host.release() : host.stop())).catch(() => undefined)
    }
  }

  stopAll(): void {
    for (const id of [...this.hosts.keys()]) this.stop(id)
  }

  private async spawnKeptHost(workspaceId: string, kept: KeptSandboxHosts): Promise<string | null> {
    const channel = kept.channel(workspaceId)
    if (Buffer.byteLength(channel) > socketPathLimit(process.platform)) return null
    const tmpDir = this.deps.tmpDir(workspaceId)
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
    rmSync(channel, { force: true })
    try {
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
    } catch {
      return null
    }
    this.keptHosts.add(workspaceId)
    await waitForChannel(channel)
    return channel
  }

  host(workspaceId: string): Promise<SandboxHost> {
    const existing = this.hosts.get(workspaceId)
    if (existing) return existing
    const endWatch = this.deps.watchLeftBehind?.(workspaceId)
    const host = new SandboxHost({
      nodePath: this.deps.nodePath,
      hostScript: this.deps.hostScript,
      env: {
        ...(this.deps.hostEnv ?? process.env),
        CLAUDE_CODE_TMPDIR: this.deps.tmpDir(workspaceId),
      },
      onAsk: (h, port) => this.deps.onAsk(workspaceId, h, port),
      onPackageBlocked: (pkg, reason) => this.deps.onPackageBlocked?.(workspaceId, pkg, reason),
      onViolations: (lines) => this.deps.onViolations?.(workspaceId, lines),
      onExit: () => {
        if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
        this.keptHosts.delete(workspaceId)
        if (!this.released.has(workspaceId)) endWatch?.()
      },
    })
    const started = (async () => {
      const kept = this.deps.kept
      const existing = kept?.claim(workspaceId)
      if (existing) {
        this.deps.adoptKeptTmp(workspaceId, existing.tmpDir)
        this.keptHosts.add(workspaceId)
        await host.attach(
          existing.channel,
          this.deps.config(workspaceId),
          this.deps.packagePolicy(workspaceId),
          false,
        )
      } else {
        const channel = kept?.enabled() ? await this.spawnKeptHost(workspaceId, kept) : null
        if (channel) {
          await host.attach(
            channel,
            this.deps.config(workspaceId),
            this.deps.packagePolicy(workspaceId),
            true,
          )
        } else {
          await host.start(this.deps.config(workspaceId), this.deps.packagePolicy(workspaceId))
        }
      }
      return host
    })().catch((err: unknown) => {
      if (this.hosts.get(workspaceId) === started) this.hosts.delete(workspaceId)
      host.stop()
      if (this.keptHosts.delete(workspaceId)) this.deps.kept?.stop(workspaceId)
      throw err
    })
    this.hosts.set(workspaceId, started)
    return started
  }
}
