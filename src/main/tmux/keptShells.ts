import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

export interface KeptMeta {
  paneId: string
  externalId: string
  token: string
  workspaceId: string
  shell: string
  stateFile: string
  spawnPath: string
  process?: KeptProcessMeta
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
  return { ...(fields as KeptMeta), ...(keptProcess ? { process: keptProcess } : {}) }
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

export class KeptShells {
  private server: TmuxServer | null = null
  private connecting: Promise<TmuxServer> | null = null
  private readonly waiting = new Map<string, { window: KeptWindow; meta: KeptMeta }>()
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

  async quit(): Promise<void> {
    this.waiting.clear()
    const server = this.server ?? (this.socketExists() ? await this.connect() : null)
    await server?.killServer()
    this.server = null
  }

  quitNow(): void {
    this.waiting.clear()
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
    for (const window of await server.windows()) {
      const meta = parseKeptMeta(window.meta)
      if (meta && !window.dead && saved?.has(meta.paneId)) {
        this.waiting.set(meta.paneId, { window, meta })
        continue
      }
      this.deps.log('pty-reap', { pane: meta?.paneId ?? '', reason: 'unclaimed' })
      await server.killWindow(window.windowId)
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
