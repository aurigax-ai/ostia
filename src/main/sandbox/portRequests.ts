import type { ApprovalOutcome } from '../../shared/approvals'
import { type PortsPolicy, checkExposePort } from '../../shared/sandbox'
import type { ExposeResult, SandboxListener } from './portForwarder'

export interface PortAsk {
  workspaceId: string
  paneId?: string
  port: number
  process: string | null
  origin: 'agent' | 'listener'
}

export interface PortRequestsDeps {
  platform: NodeJS.Platform
  isSandboxed: (workspaceId: string) => boolean
  policy: (workspaceId: string) => PortsPolicy
  ask: (ask: PortAsk) => Promise<ApprovalOutcome>
  forwarder: {
    listeners: (workspaceId: string) => SandboxListener[]
    exposed: (workspaceId: string) => number[]
    expose: (workspaceId: string, port: number) => Promise<ExposeResult>
    unexpose: (workspaceId: string, port: number) => Promise<void>
  }
}

export type PortRequestResult =
  | { ok: true; port: number; notice?: 'not-needed-on-macos' }
  | { ok: false; error: 'invalid-port' | 'not-sandboxed' | 'denied' | ExposeFailure }

type ExposeFailure = Extract<ExposeResult, { ok: false }>['error']

export interface PortRow {
  port: number
  process: string | null
  exposed: boolean
}

function granted(outcome: ApprovalOutcome): boolean {
  return outcome === 'workspace' || outcome === 'session'
}

export class PortRequests {
  private readonly seen = new Map<string, Map<number, SandboxListener>>()

  constructor(private readonly deps: PortRequestsDeps) {}

  async request(workspaceId: string, paneId: string, input: string): Promise<PortRequestResult> {
    const port = checkExposePort(input)
    if (port === null) return { ok: false, error: 'invalid-port' }
    if (!this.deps.isSandboxed(workspaceId)) return { ok: false, error: 'not-sandboxed' }
    if (this.deps.platform === 'darwin') return { ok: true, port, notice: 'not-needed-on-macos' }
    if (this.deps.forwarder.exposed(workspaceId).includes(port)) return { ok: true, port }
    const process = this.seen.get(workspaceId)?.get(port)?.process ?? null
    const outcome = await this.deps.ask({ workspaceId, paneId, port, process, origin: 'agent' })
    if (!granted(outcome)) return { ok: false, error: 'denied' }
    return this.deps.forwarder.expose(workspaceId, port)
  }

  exposeByHuman(workspaceId: string, port: number): Promise<ExposeResult> {
    return this.deps.forwarder.expose(workspaceId, port)
  }

  unexposeByHuman(workspaceId: string, port: number): Promise<void> {
    return this.deps.forwarder.unexpose(workspaceId, port)
  }

  ports(workspaceId: string): PortRow[] {
    const exposed = new Set(this.deps.forwarder.exposed(workspaceId))
    return [...(this.seen.get(workspaceId)?.values() ?? [])].map((l) => ({
      port: l.port,
      process: l.process,
      exposed: exposed.has(l.port),
    }))
  }

  async scan(workspaceId: string): Promise<void> {
    if (this.deps.platform !== 'linux' || !this.deps.isSandboxed(workspaceId)) return
    const current = new Map(this.deps.forwarder.listeners(workspaceId).map((l) => [l.port, l]))
    const previous = this.seen.get(workspaceId) ?? new Map<number, SandboxListener>()
    this.seen.set(workspaceId, current)
    for (const port of previous.keys()) {
      if (!current.has(port)) await this.deps.forwarder.unexpose(workspaceId, port)
    }
    for (const listener of current.values()) {
      if (previous.has(listener.port)) continue
      await this.onNewListener(workspaceId, listener)
    }
  }

  forget(workspaceId: string): void {
    this.seen.delete(workspaceId)
  }

  private async onNewListener(workspaceId: string, listener: SandboxListener): Promise<void> {
    const policy = this.deps.policy(workspaceId)
    if (policy === 'deny') return
    if (policy === 'ask') {
      const outcome = await this.deps.ask({
        workspaceId,
        port: listener.port,
        process: listener.process,
        origin: 'listener',
      })
      if (!granted(outcome)) return
    }
    await this.deps.forwarder.expose(workspaceId, listener.port)
  }
}
