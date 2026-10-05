import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalOutcome } from '../../shared/approvals'
import type { SecretEntry } from '../../shared/secrets'

const SECRET_ENV_NAME = /_(TOKEN|KEY|SECRET|PASSWORD)$/
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const KEY_PEEK_BYTES = 128

export interface SecretAsk {
  workspaceId: string
  paneId: string
  name: string
  reason: string
}

export interface SecretServiceDeps {
  home: () => string
  env: () => Record<string, string | undefined>
  ghToken: () => string | null
  vault: {
    list: (workspaceId: string) => { key: string; scope: 'global' | 'project' }[]
    get: (key: string, scope: 'global' | 'project', workspaceId: string) => string | null
  }
  grantedIds: (workspaceId: string) => string[]
  ask: (ask: SecretAsk) => Promise<ApprovalOutcome>
}

export type SecretGetResult =
  | { ok: true; value: string }
  | { ok: false; error: 'unknown-secret' | 'ambiguous' | 'denied' | 'missing' }

function sshKeys(home: string): string[] {
  const dir = join(home, '.ssh')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => {
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) return false
      const head = readFileSync(path, { encoding: 'utf8' }).slice(0, KEY_PEEK_BYTES)
      return PRIVATE_KEY_HEADER.test(head)
    } catch {
      return false
    }
  })
}

export class SecretService {
  private readonly untilRestart = new Map<string, Set<string>>()

  constructor(private readonly deps: SecretServiceDeps) {}

  list(workspaceId: string): SecretEntry[] {
    const home = this.deps.home()
    const env = this.deps.env()
    const out: SecretEntry[] = []
    for (const name of sshKeys(home)) {
      out.push({ id: `host:ssh:${name}`, name, source: 'host', kind: 'ssh-key', editable: false })
    }
    for (const name of Object.keys(env).sort()) {
      if (SECRET_ENV_NAME.test(name) && env[name]) {
        out.push({ id: `host:env:${name}`, name, source: 'host', kind: 'env', editable: false })
      }
    }
    if (this.deps.ghToken() !== null) {
      out.push({
        id: 'host:gh',
        name: 'gh auth token',
        source: 'host',
        kind: 'gh-token',
        editable: false,
      })
    }
    for (const { key, scope } of this.deps.vault.list(workspaceId)) {
      out.push({
        id: `ostia:${scope}:${key}`,
        name: key,
        source: 'ostia',
        kind: 'vault',
        editable: true,
      })
    }
    return out
  }

  value(workspaceId: string, id: string): string | null {
    const [source, kind, ...rest] = id.split(':')
    const tail = rest.join(':')
    if (source === 'host' && kind === 'ssh') {
      try {
        return readFileSync(join(this.deps.home(), '.ssh', tail), 'utf8')
      } catch {
        return null
      }
    }
    if (source === 'host' && kind === 'env') return this.deps.env()[tail] ?? null
    if (source === 'host' && kind === 'gh') return this.deps.ghToken()
    if (source === 'ostia' && (kind === 'global' || kind === 'project')) {
      return this.deps.vault.get(tail, kind, workspaceId)
    }
    return null
  }

  async get(
    workspaceId: string,
    paneId: string,
    name: string,
    reason: string,
  ): Promise<SecretGetResult> {
    const matches = this.list(workspaceId).filter((s) => s.name === name || s.id === name)
    if (matches.length === 0) return { ok: false, error: 'unknown-secret' }
    if (matches.length > 1) return { ok: false, error: 'ambiguous' }
    const secret = matches[0]
    const trusted =
      this.deps.grantedIds(workspaceId).includes(secret.id) ||
      this.untilRestart.get(workspaceId)?.has(secret.id)
    if (!trusted) {
      const outcome = await this.deps.ask({ workspaceId, paneId, name: secret.name, reason })
      if (outcome !== 'once' && outcome !== 'session') return { ok: false, error: 'denied' }
      if (outcome === 'session') {
        const set = this.untilRestart.get(workspaceId) ?? new Set<string>()
        set.add(secret.id)
        this.untilRestart.set(workspaceId, set)
      }
    }
    const value = this.value(workspaceId, secret.id)
    return value === null ? { ok: false, error: 'missing' } : { ok: true, value }
  }

  forget(workspaceId: string): void {
    this.untilRestart.delete(workspaceId)
  }
}
