import { type SandboxControls, hostMatches } from '../../shared/sandbox'

export interface BrowserPolicy {
  browser: SandboxControls['browser']
  domains: readonly string[]
  denied?: readonly string[]
}

export interface BrowserFenceDeps {
  policy: (workspaceId: string) => BrowserPolicy | null
  requestDomain: (workspaceId: string, host: string) => Promise<boolean>
}

const WEB_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 }

function parse(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url)
    const fallback = WEB_PORTS[parsed.protocol]
    if (fallback === undefined) return null
    return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : fallback }
  } catch {
    return null
  }
}

export class BrowserFence {
  constructor(private readonly deps: BrowserFenceDeps) {}

  allowedNow(workspaceId: string, url: string): boolean {
    const policy = this.deps.policy(workspaceId)
    if (!policy || policy.browser === 'unrestricted') return true
    const target = parse(url)
    if (!target || hostMatches(target.host, target.port, policy.denied ?? [])) return false
    return hostMatches(target.host, target.port, policy.domains)
  }

  async check(workspaceId: string, url: string): Promise<boolean> {
    if (this.allowedNow(workspaceId, url)) return true
    const target = parse(url)
    if (!target) return false
    const denied = this.deps.policy(workspaceId)?.denied ?? []
    if (hostMatches(target.host, target.port, denied)) return false
    return (
      (await this.deps.requestDomain(workspaceId, target.host)) && this.allowedNow(workspaceId, url)
    )
  }
}
