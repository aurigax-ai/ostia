import type { SecretSpan } from '../../shared/privacy/redaction'
import type { SecretSyncStatus, SyncStatus } from '../../shared/profileSync/profileSync'
import type { SyncKinds } from '../../shared/profileSync/syncKinds'
import { FolderUnreadable, type SyncedExtension } from './profile'
import type { SecretSync } from './secrets'
import { createSyncPlanner, type Plan, ScanFailed } from './syncPlan'
import { createSyncStore, type SyncState, type SyncStore } from './syncStore'

export type DetectSecrets = (text: string) => Promise<SecretSpan[]>

export interface SyncSnapshot {
  files: Map<string, string>
  version: string
  skipped: string[]
}

export type WriteResult = { ok: true; version: string } | { ok: false }

export interface SyncMethod {
  id: string
  read: () => Promise<SyncSnapshot>
  write: (files: ReadonlyMap<string, string>, expected: string) => Promise<WriteResult>
}

export class SyncTargetError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface ProfileSyncDeps {
  userData: string
  configDir: string
  now?: () => Date
  method: () => SyncMethod | null
  targetLabel: () => string | null
  kinds: () => SyncKinds
  installedExtensions: () => SyncedExtension[]
  builtinIds: () => string[]
  installExtension: (id: string, marketplace: string) => Promise<boolean>
  detectSecrets: DetectSecrets
  secrets?: SecretSync
}

export interface SyncRunResult {
  status: SyncStatus
  pulledSettings: boolean
}

const WRITE_ATTEMPTS = 3

const SECRETS_OFF: SecretSyncStatus = { state: 'off', mode: 'password', logins: false }

const OFF: SyncStatus = {
  dir: null,
  state: 'off',
  lastSync: null,
  skipped: [],
  heldBack: [],
  offers: [],
  secrets: SECRETS_OFF,
}

export class ProfileSync {
  private last: SyncStatus = OFF
  private running: Promise<SyncRunResult> | null = null
  private readonly store: SyncStore
  private readonly planner: ReturnType<typeof createSyncPlanner>

  constructor(private readonly deps: ProfileSyncDeps) {
    this.store = createSyncStore(deps)
    this.planner = createSyncPlanner(deps, this.store, () => this.now())
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private statusOf(state: SyncState, error?: string): SyncStatus {
    return {
      dir: this.deps.targetLabel(),
      state: error ? 'error' : 'ok',
      ...(error ? { error } : {}),
      lastSync: state.lastSync,
      skipped: state.skipped,
      heldBack: state.heldBack,
      offers: state.offers,
      secrets: this.deps.secrets
        ? state.secrets?.state === 'damaged'
          ? state.secrets
          : this.deps.secrets.status()
        : SECRETS_OFF,
    }
  }

  status(): SyncStatus {
    const method = this.deps.method()
    if (!method) return OFF
    if (this.last.dir === this.deps.targetLabel() && this.last.state !== 'off') return this.last
    return this.statusOf(this.store.loadState(method.id))
  }

  run(): Promise<SyncRunResult> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private fail(state: SyncState, error: string): SyncRunResult {
    this.last = this.statusOf(state, error)
    return { status: this.last, pulledSettings: false }
  }

  private async runOnce(): Promise<SyncRunResult> {
    const method = this.deps.method()
    if (!method) {
      this.last = OFF
      return { status: OFF, pulledSettings: false }
    }
    const state = this.store.loadState(method.id)
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let remote: SyncSnapshot
      try {
        remote = await method.read()
      } catch (err) {
        return this.fail(state, err instanceof SyncTargetError ? err.code : 'unreachable')
      }
      let plan: Plan
      try {
        plan = await this.planner.plan(remote, state)
      } catch (err) {
        if (err instanceof ScanFailed) return this.fail(state, 'scan-failed')
        if (err instanceof FolderUnreadable) return this.fail(state, 'unreachable')
        throw err
      }
      let version = remote.version
      if (plan.write) {
        let res: WriteResult
        try {
          res = await method.write(plan.outgoing, remote.version)
        } catch (err) {
          return this.fail(state, err instanceof SyncTargetError ? err.code : 'unreachable')
        }
        if (!res.ok) continue
        version = res.version
      }
      const pulledSettings = plan.apply()
      this.store.saveBase(method.id, plan.baseline)
      plan.saveSecretBase()
      const next = plan.state(version)
      this.store.saveState(next)
      const error = plan.invalid.length ? `invalid-json:${plan.invalid.join(',')}` : undefined
      this.last = this.statusOf(next, error)
      return { status: this.last, pulledSettings }
    }
    return this.fail(state, 'busy')
  }

  async install(id: string): Promise<SyncStatus> {
    const method = this.deps.method()
    if (!method) return OFF
    const offer = this.store.loadState(method.id).offers.find((o) => o.id === id)
    if (!offer) return this.status()
    await this.deps.installExtension(offer.id, offer.marketplace)
    return (await this.run()).status
  }
}
