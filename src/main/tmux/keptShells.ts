import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_PROTOCOL_VERSION } from '../sandbox/protocol'
import type { NewWindowSpec } from './tmuxCommand'
import { type KeptWindow, type TmuxPane, TmuxServer, type TmuxServerOptions } from './tmuxServer'

export interface KeptProcessMeta {
  name: string
  cmd: string
  cwd?: string
  ownerPaneId: string
  startedAt: string
  status: 'starting' | 'running' | 'exited'
  exitCode?: number
}

export interface KeptSandboxMeta {
  stamp: string | null
  bridgeId: string | null
  resizePipe: string | null
}

export interface KeptMeta {
  paneId: string
  externalId: string
  token: string
  workspaceId: string
  shell: string
  stateFile: string
  spawnPath: string
  process?: KeptProcessMeta
  sandbox?: KeptSandboxMeta
}

export const SANDBOX_HOST_KIND = 'sandbox-host'

export interface KeptHostMeta {
  kind: typeof SANDBOX_HOST_KIND
  workspaceId: string
  channel: string
  tmpDir: string
  protocol: number
  exposed: number[]
}

export function parseKeptHost(raw: unknown): KeptHostMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const workspaceId = text(r.workspaceId)
  const channel = text(r.channel)
  const tmpDir = text(r.tmpDir)
  if (r.kind !== SANDBOX_HOST_KIND || !workspaceId || !channel || !tmpDir) return null
  const exposed = Array.isArray(r.exposed)
    ? r.exposed.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 65536)
    : []
  const protocol = Number.isInteger(r.protocol) ? (r.protocol as number) : 0
  return { kind: SANDBOX_HOST_KIND, workspaceId, channel, tmpDir, protocol, exposed }
}

function nullableText(raw: unknown): string | null {
  return raw === null ? null : text(raw)
}

function parseSandbox(raw: unknown): KeptSandboxMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  return {
    stamp: nullableText(r.stamp),
    bridgeId: nullableText(r.bridgeId),
    resizePipe: nullableText(r.resizePipe),
  }
}

const PROCESS_STATUSES = new Set(['starting', 'running', 'exited'])

function parseProcess(raw: unknown): KeptProcessMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const name = text(r.name)
  const cmd = text(r.cmd)
  const ownerPaneId = text(r.ownerPaneId)
  const startedAt = text(r.startedAt)
  if (!name || !cmd || !ownerPaneId || !startedAt || !PROCESS_STATUSES.has(String(r.status))) {
    return undefined
  }
  const cwd = text(r.cwd)
  return {
    name,
    cmd,
    ownerPaneId,
    startedAt,
    status: r.status as KeptProcessMeta['status'],
    ...(cwd ? { cwd } : {}),
    ...(Number.isInteger(r.exitCode) ? { exitCode: r.exitCode as number } : {}),
  }
}

const TEXT_MAX = 4096

function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= TEXT_MAX ? raw : null
}

export function parseKeptMeta(raw: unknown): KeptMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const fields = {
    paneId: text(r.paneId),
    externalId: text(r.externalId),
    token: text(r.token),
    workspaceId: text(r.workspaceId),
    shell: text(r.shell),
    stateFile: text(r.stateFile),
    spawnPath: text(r.spawnPath),
  }
  if (Object.values(fields).some((v) => v === null) || !fields.paneId || !fields.token) return null
  const keptProcess = parseProcess(r.process)
  const sandbox = parseSandbox(r.sandbox)
  return {
    ...(fields as KeptMeta),
    ...(keptProcess ? { process: keptProcess } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
}

export interface KeptShell {
  pane: TmuxPane
  meta: KeptMeta
}

export type KeptShellsLog = (event: string, fields: Record<string, string>) => void

export interface KeptShellsDeps {
  options: () => TmuxServerOptions | null
  log: KeptShellsLog
}

export type KeptSpawnSpec = Omit<NewWindowSpec, 'session'> & {
  cols: number
  rows: number
  meta: KeptMeta
}

export type KeptHostSpawnSpec = Omit<NewWindowSpec, 'session'> & { meta: KeptHostMeta }

interface Waiting<M> {
  window: KeptWindow
  meta: M
}

const HOST_WINDOW_COLS = 80
const HOST_WINDOW_ROWS = 24

export class KeptShells {
  private server: TmuxServer | null = null
  private connecting: Promise<TmuxServer> | null = null
  private readonly waiting = new Map<string, Waiting<KeptMeta>>()
  private readonly hosts = new Map<string, Waiting<KeptHostMeta>>()
  private readonly lostSandbox = new Set<string>()
  ready: Promise<void> = Promise.resolve()

  constructor(private readonly deps: KeptShellsDeps) {}

  start(keep: boolean, saved: ReadonlySet<string> | null): Promise<void> {
    this.ready = this.reconcile(keep, saved).catch((err: unknown) => {
      this.deps.log('kept-shells-start-failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return this.ready
  }

  claim(paneId: string): KeptShell | null {
    const kept = this.waiting.get(paneId)
    if (!kept || !this.server?.alive) return null
    this.waiting.delete(paneId)
    return { pane: this.server.adopt(kept.window), meta: kept.meta }
  }

  isWaiting(paneId: string): boolean {
    return this.waiting.has(paneId)
  }

  async spawn(spec: KeptSpawnSpec): Promise<TmuxPane> {
    return (await this.connect()).spawn(spec)
  }

  async spawnHost(spec: KeptHostSpawnSpec): Promise<TmuxPane> {
    return (await this.connect()).spawn({
      ...spec,
      cols: HOST_WINDOW_COLS,
      rows: HOST_WINDOW_ROWS,
    })
  }

  keptHost(workspaceId: string): KeptHostMeta | undefined {
    return this.hosts.get(workspaceId)?.meta
  }

  claimHost(workspaceId: string): { pane: TmuxPane; meta: KeptHostMeta } | null {
    const kept = this.hosts.get(workspaceId)
    if (!kept || !this.server?.alive) return null
    this.hosts.delete(workspaceId)
    return { pane: this.server.adopt(kept.window), meta: kept.meta }
  }

  keptHostWorkspaces(): string[] {
    return [...this.hosts.keys()]
  }

  takeSandboxLost(paneId: string): boolean {
    return this.lostSandbox.delete(paneId)
  }

  async quit(): Promise<void> {
    this.waiting.clear()
    this.hosts.clear()
    const server = this.server ?? (this.socketExists() ? await this.connect() : null)
    await server?.killServer()
    this.server = null
  }

  quitNow(): void {
    this.waiting.clear()
    this.hosts.clear()
    this.server?.close()
    this.server = null
    const options = this.deps.options()
    if (!options || !existsSync(join(options.dir, options.name))) return
    try {
      execFileSync(options.tmux, ['-S', join(options.dir, options.name), 'kill-server'], {
        stdio: 'ignore',
        timeout: 3000,
      })
    } catch {}
  }

  release(): void {
    this.waiting.clear()
    this.hosts.clear()
    this.server?.close()
    this.server = null
  }

  private async reconcile(keep: boolean, saved: ReadonlySet<string> | null): Promise<void> {
    if (!this.socketExists()) return
    const server = await this.connect()
    if (!keep) {
      for (const window of await server.windows()) {
        this.deps.log('pty-reap', {
          pane: parseKeptMeta(window.meta)?.paneId ?? '',
          reason: 'setting-off',
        })
      }
      await this.quit()
      return
    }
    const windows = await server.windows()
    const liveHosts = new Map<string, Waiting<KeptHostMeta>>()
    for (const window of windows) {
      const host = parseKeptHost(window.meta)
      if (host && !window.dead && host.protocol === HOST_PROTOCOL_VERSION) {
        liveHosts.set(host.workspaceId, { window, meta: host })
      }
    }
    for (const window of windows) {
      const host = parseKeptHost(window.meta)
      if (host) {
        if (liveHosts.get(host.workspaceId)?.window === window) continue
        if (!window.dead) {
          this.deps.log('sandbox-host-reap', { workspace: host.workspaceId, reason: 'protocol' })
        }
        await server.killWindow(window.windowId)
        continue
      }
      const meta = parseKeptMeta(window.meta)
      const claimed = meta !== null && !window.dead && saved?.has(meta.paneId) === true
      if (meta && claimed && meta.sandbox && !liveHosts.has(meta.workspaceId)) {
        this.lostSandbox.add(meta.paneId)
        this.deps.log('pty-reap', { pane: meta.paneId, reason: 'sandbox-gone' })
        await server.killWindow(window.windowId)
        continue
      }
      if (meta && claimed) {
        this.waiting.set(meta.paneId, { window, meta })
        continue
      }
      this.deps.log('pty-reap', { pane: meta?.paneId ?? '', reason: 'unclaimed' })
      await server.killWindow(window.windowId)
    }
    const kept = [...this.waiting.values()]
    for (const [workspaceId, host] of liveHosts) {
      if (kept.some(({ meta }) => meta.sandbox && meta.workspaceId === workspaceId)) {
        this.hosts.set(workspaceId, host)
        continue
      }
      this.deps.log('sandbox-host-reap', { workspace: workspaceId, reason: 'unclaimed' })
      await server.killWindow(host.window.windowId)
    }
  }

  private socketExists(): boolean {
    const options = this.deps.options()
    return options !== null && existsSync(join(options.dir, options.name))
  }

  private connect(): Promise<TmuxServer> {
    if (this.server?.alive) return Promise.resolve(this.server)
    if (this.connecting) return this.connecting
    const options = this.deps.options()
    if (!options) return Promise.reject(new Error('tmux is not available'))
    let server: TmuxServer | null = null
    const connecting = TmuxServer.connect(options, () => {
      if (this.server === server) this.server = null
      this.waiting.clear()
      this.hosts.clear()
    })
    this.connecting = connecting
    return connecting
      .then((connected) => {
        server = connected
        this.server = connected
        return connected
      })
      .finally(() => {
        if (this.connecting === connecting) this.connecting = null
      })
  }
}
