import type { ApprovalOutcome } from '../../shared/approvals'
import { type DomainRefusal, checkDomainPattern, hostMatches } from '../../shared/sandbox'

const WEB_PORT = 443

export interface DomainAsk {
  workspaceId: string
  paneId?: string
  host: string
  origin: 'agent' | 'blocked'
}

export interface DomainRequestsDeps {
  isSandboxed: (workspaceId: string) => boolean
  blockedDomains?: (workspaceId: string) => readonly string[]
  ask: (ask: DomainAsk) => Promise<ApprovalOutcome>
  allowWorkspace: (workspaceId: string, domain: string) => void
  allowUntilRestart: (workspaceId: string, domain: string) => void
  now: () => number
}

export type DomainRequestResult =
  | { ok: true; domain: string }
  | { ok: false; error: 'invalid-domain' | 'not-sandboxed' | 'denied'; reason?: string }

export class DomainRequests {
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly denied = new Map<string, Map<string, DomainRefusal>>()
  private readonly allowed = new Map<string, Set<string>>()

  constructor(private readonly deps: DomainRequestsDeps) {}

  async request(workspaceId: string, paneId: string, host: string): Promise<DomainRequestResult> {
    const checked = checkDomainPattern(host)
    if (!checked.ok) return { ok: false, error: 'invalid-domain', reason: checked.reason }
    if (!this.deps.isSandboxed(workspaceId)) return { ok: false, error: 'not-sandboxed' }
    if (this.isBlocked(workspaceId, checked.domain)) return { ok: false, error: 'denied' }
    const allowed = await this.decide(workspaceId, checked.domain, 'agent', paneId)
    return allowed ? { ok: true, domain: checked.domain } : { ok: false, error: 'denied' }
  }

  private isBlocked(workspaceId: string, domain: string): boolean {
    const blocked = this.deps.blockedDomains?.(workspaceId) ?? []
    const [host, port] = domain.replace(/^\*\./, '').split(':')
    return hostMatches(host, port ? Number(port) : WEB_PORT, blocked)
  }

  onBlocked(workspaceId: string, host: string, _port?: number): Promise<boolean> {
    const domain = host.toLowerCase()
    if (this.allowed.get(workspaceId)?.has(domain)) return Promise.resolve(true)
    const refusal = this.denied.get(workspaceId)?.get(domain)
    if (refusal) {
      refusal.count += 1
      refusal.last = this.deps.now()
      return Promise.resolve(false)
    }
    return this.decide(workspaceId, domain, 'blocked')
  }

  refusals(workspaceId: string): DomainRefusal[] {
    return [...(this.denied.get(workspaceId)?.values() ?? [])].map((r) => ({ ...r }))
  }

  allowFromView(workspaceId: string, host: string): void {
    const domain = host.toLowerCase()
    this.denied.get(workspaceId)?.delete(domain)
    this.markAllowed(workspaceId, domain)
    this.deps.allowWorkspace(workspaceId, domain)
  }

  forget(workspaceId: string): void {
    this.denied.delete(workspaceId)
    this.allowed.delete(workspaceId)
  }

  private decide(
    workspaceId: string,
    domain: string,
    origin: DomainAsk['origin'],
    paneId?: string,
  ): Promise<boolean> {
    const key = `${workspaceId}\u0000${domain}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const decision = this.deps
      .ask({ workspaceId, host: domain, origin, ...(paneId ? { paneId } : {}) })
      .catch((): ApprovalOutcome => 'deny')
      .then((outcome) => this.settle(workspaceId, domain, outcome))
      .finally(() => this.pending.delete(key))
    this.pending.set(key, decision)
    return decision
  }

  private settle(workspaceId: string, domain: string, outcome: ApprovalOutcome): boolean {
    if (outcome === 'workspace' || outcome === 'session') {
      this.markAllowed(workspaceId, domain)
      if (outcome === 'workspace') this.deps.allowWorkspace(workspaceId, domain)
      else this.deps.allowUntilRestart(workspaceId, domain)
      return true
    }
    const byHost = this.denied.get(workspaceId) ?? new Map<string, DomainRefusal>()
    byHost.set(domain, { host: domain, count: 1, last: this.deps.now() })
    this.denied.set(workspaceId, byHost)
    return false
  }

  private markAllowed(workspaceId: string, domain: string): void {
    const set = this.allowed.get(workspaceId) ?? new Set<string>()
    set.add(domain)
    this.allowed.set(workspaceId, set)
  }
}
