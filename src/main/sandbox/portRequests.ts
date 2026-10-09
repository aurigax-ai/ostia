import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import { type PortsPolicy, checkExposePort } from '../../shared/sandbox/sandbox'
import type { ExposeRefusal, ExposeResult, SandboxListener } from './portForwarder'

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
    refusal: (workspaceId: string) => ExposeRefusal | null
    expose: (workspaceId: string, port: number) => Promise<ExposeResult>
    unexpose: (workspaceId: string, port: number) => Promise<void>
  }
}

export type PortRequestResult =
  | { ok: true; port: number; notice?: 'not-needed-on-macos' }
  | { ok: false; error: 'invalid-port' | 'not-sandboxed' | 'denied' | ExposeFailure }

type ExposeFailure = Extract<ExposeResult, { ok: false }>['error']

export interface KeptExposure {
  port: number
  process: string
  pid?: number
  byHuman?: true
}

function sameProgram(kept: KeptExposure, listener: SandboxListener): boolean {
  return kept.process === listener.process && kept.pid === listener.pid
}

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
  private readonly kept = new Map<string, Map<number, KeptExposure>>()
  private readonly byHuman = new Map<string, Set<number>>()

  constructor(private readonly deps: PortRequestsDeps) {}

  async request(workspaceId: string, paneId: string, input: string): Promise<PortRequestResult> {
    const port = checkExposePort(input)
    if (port === null) return { ok: false, error: 'invalid-port' }
    if (!this.deps.isSandboxed(workspaceId)) return { ok: false, error: 'not-sandboxed' }
    if (this.deps.platform === 'darwin') return { ok: true, port, notice: 'not-needed-on-macos' }
    if (this.deps.forwarder.exposed(workspaceId).includes(port)) return { ok: true, port }
    const refusal = this.deps.forwarder.refusal(workspaceId)
    if (refusal) return { ok: false, error: refusal }
    const process = this.seen.get(workspaceId)?.get(port)?.process ?? null
    const outcome = await this.deps.ask({ workspaceId, paneId, port, process, origin: 'agent' })
    if (!granted(outcome)) return { ok: false, error: 'denied' }
    return this.deps.forwarder.expose(workspaceId, port)
  }

  async exposeByHuman(workspaceId: string, port: number): Promise<ExposeResult> {
    const result = await this.deps.forwarder.expose(workspaceId, port)
    if (result.ok) this.markByHuman(workspaceId, port)
    return result
  }

  unexposeByHuman(workspaceId: string, port: number): Promise<void> {
    this.byHuman.get(workspaceId)?.delete(port)
    return this.deps.forwarder.unexpose(workspaceId, port)
  }

  exposures(workspaceId: string, listening?: readonly SandboxListener[]): KeptExposure[] {
    const seen = listening ? new Map(listening.map((l) => [l.port, l])) : this.seen.get(workspaceId)
    const human = this.byHuman.get(workspaceId)
    const out: KeptExposure[] = []
    for (const port of this.deps.forwarder.exposed(workspaceId)) {
      const listener = seen?.get(port)
      if (!listener?.process) continue
      out.push({
        port,
        process: listener.process,
        ...(listener.pid === undefined ? {} : { pid: listener.pid }),
        ...(human?.has(port) ? { byHuman: true as const } : {}),
      })
    }
    return out
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
      if (current.has(port)) continue
      this.byHuman.get(workspaceId)?.delete(port)
      await this.deps.forwarder.unexpose(workspaceId, port)
    }
    const kept = this.kept.get(workspaceId)
    for (const listener of current.values()) {
      if (previous.has(listener.port) && !kept?.has(listener.port)) continue
      await this.onNewListener(workspaceId, listener)
    }
    if (kept && this.deps.forwarder.refusal(workspaceId) === null) {
      for (const port of [...kept.keys()]) if (!current.has(port)) kept.delete(port)
    }
  }

  keep(workspaceId: string, exposures: readonly KeptExposure[]): void {
    if (this.kept.has(workspaceId)) return
    this.kept.set(workspaceId, new Map(exposures.map((e) => [e.port, e])))
  }

  forget(workspaceId: string): void {
    this.seen.delete(workspaceId)
    this.kept.delete(workspaceId)
    this.byHuman.delete(workspaceId)
  }

  private markByHuman(workspaceId: string, port: number): void {
    const set = this.byHuman.get(workspaceId) ?? new Set<number>()
    set.add(port)
    this.byHuman.set(workspaceId, set)
  }

  private async onNewListener(workspaceId: string, listener: SandboxListener): Promise<void> {
    const kept = this.kept.get(workspaceId)
    if (this.deps.forwarder.exposed(workspaceId).includes(listener.port)) {
      kept?.delete(listener.port)
      return
    }
    if (this.deps.forwarder.refusal(workspaceId)) return
    const restored = kept?.get(listener.port)
    kept?.delete(listener.port)
    const policy = this.deps.policy(workspaceId)
    if (restored && sameProgram(restored, listener) && (policy !== 'deny' || restored.byHuman)) {
      const result = await this.deps.forwarder.expose(workspaceId, listener.port)
      if (result.ok && restored.byHuman) this.markByHuman(workspaceId, listener.port)
      return
    }
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
