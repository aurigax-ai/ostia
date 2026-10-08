import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { connect as connectSocket } from 'node:net'
import { join } from 'node:path'
import type { KeptExposure } from '../sandbox/portRequests'
import { HOST_PROTOCOL_VERSION } from '../sandbox/protocol'
import type { NewWindowSpec } from './tmuxCommand'
import {
  type KeptWindow,
  type TmuxPane,
  TmuxServer,
  type TmuxServerOptions,
  ensureTmuxSocketDir,
} from './tmuxServer'

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
  exposed: KeptExposure[]
}

function isPort(raw: unknown): raw is number {
  return Number.isInteger(raw) && (raw as number) > 0 && (raw as number) < 65536
}

function parseExposure(raw: unknown): KeptExposure | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const process = text(r.process)
  if (!isPort(r.port) || !process) return null
  return {
    port: r.port,
    process,
    ...(Number.isInteger(r.pid) && (r.pid as number) > 0 ? { pid: r.pid as number } : {}),
    ...(r.byHuman === true ? { byHuman: true as const } : {}),
  }
}

export function parseKeptHost(raw: unknown): KeptHostMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const workspaceId = text(r.workspaceId)
  const channel = text(r.channel)
  const tmpDir = text(r.tmpDir)
  if (r.kind !== SANDBOX_HOST_KIND || !workspaceId || !channel || !tmpDir) return null
  const exposed = Array.isArray(r.exposed)
    ? r.exposed.map(parseExposure).filter((e): e is KeptExposure => e !== null)
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
    workspaceId: text(r.workspaceId),
    shell: text(r.shell),
    stateFile: text(r.stateFile),
    spawnPath: text(r.spawnPath),
  }
  if (Object.values(fields).some((v) => v === null) || !fields.paneId) return null
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

export type KeptProgram = Omit<TmuxServerOptions, 'dir' | 'name'>

export interface KeptShellsDeps {
  dir: string
  name: string
  program: () => KeptProgram | null
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
const TOKENS_DIR = 'tokens'

function tokenName(paneId: string): string {
  return createHash('sha256').update(paneId).digest('hex').slice(0, 32)
}

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

  tokenFile(paneId: string): string {
    return join(this.tokensDir(), tokenName(paneId))
  }

  writeToken(paneId: string, token: string): string {
    const dir = this.tokensDir()
    ensureTmuxSocketDir(this.deps.dir, process.getuid?.() ?? 0)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = this.tokenFile(paneId)
    writeFileSync(file, token, { mode: 0o600 })
    return file
  }

  removeToken(paneId: string): void {
    rmSync(this.tokenFile(paneId), { force: true })
  }

  async quit(): Promise<void> {
    this.waiting.clear()
    this.hosts.clear()
    const server = this.server ?? (this.socketExists() ? await this.connect() : null)
    await server?.killServer()
    this.server = null
    this.sweepTokens()
  }

  quitNow(): void {
    this.waiting.clear()
    this.hosts.clear()
    this.server?.close()
    this.server = null
    this.sweepTokens()
    const program = this.socketExists() ? this.deps.program() : null
    if (!program) return
    try {
      execFileSync(program.tmux, ['-S', this.socketPath(), 'kill-server'], {
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
    if (!(await this.socketAnswers())) {
      this.sweepTokens()
      return
    }
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
    this.sweepTokens(new Set([...this.waiting.keys()].map(tokenName)))
  }

  private tokensDir(): string {
    return join(this.deps.dir, TOKENS_DIR, this.deps.name)
  }

  private sweepTokens(keep: ReadonlySet<string> = new Set()): void {
    let names: string[] = []
    try {
      names = readdirSync(this.tokensDir())
    } catch {
      return
    }
    for (const name of names) {
      if (!keep.has(name)) rmSync(join(this.tokensDir(), name), { force: true })
    }
  }

  private socketPath(): string {
    return join(this.deps.dir, this.deps.name)
  }

  private async socketAnswers(): Promise<boolean> {
    if (!this.socketExists()) return false
    const answers = await new Promise<boolean>((resolve) => {
      const socket = connectSocket(this.socketPath())
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (!answers) rmSync(this.socketPath(), { force: true })
    return answers
  }

  private socketExists(): boolean {
    return existsSync(this.socketPath())
  }

  private connect(): Promise<TmuxServer> {
    if (this.server?.alive) return Promise.resolve(this.server)
    if (this.connecting) return this.connecting
    const program = this.deps.program()
    if (!program) return Promise.reject(new Error('tmux is not available'))
    const options: TmuxServerOptions = { ...program, dir: this.deps.dir, name: this.deps.name }
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
