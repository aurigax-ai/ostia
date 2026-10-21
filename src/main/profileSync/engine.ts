import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { SecretSpan } from '../../shared/privacy/redaction'
import type {
  SecretSyncStatus,
  SyncConflict,
  SyncStatus,
} from '../../shared/profileSync/profileSync'
import { keyPath, withValueAt } from './merge'
import { removeRegularFile, SETTINGS_FILE, type SyncedExtension } from './profile'
import type { SecretSync } from './secrets'
import { createSyncPlanner, type Plan, ScanFailed } from './syncPlan'
import {
  createSyncStore,
  type Held,
  type StoredConflict,
  type SyncState,
  type SyncStore,
  stamp,
} from './syncStore'

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
const SHOWN_VALUE_MAX = 120

const SECRETS_OFF: SecretSyncStatus = { state: 'off', logins: false }

const OFF: SyncStatus = {
  dir: null,
  state: 'off',
  lastSync: null,
  conflicts: [],
  skipped: [],
  heldBack: [],
  offers: [],
  secrets: SECRETS_OFF,
}

const shown = (value: Held, kind: StoredConflict['kind']): string | null => {
  if (value === null) return null
  const text = kind === 'setting' ? JSON.stringify(value.value) : String(value.value)
  return text.length > SHOWN_VALUE_MAX ? `${text.slice(0, SHOWN_VALUE_MAX)}…` : text
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
      conflicts: state.conflicts.map(
        (c): SyncConflict => ({
          id: c.id,
          kind: c.kind,
          key: c.key,
          local: shown(c.local, c.kind),
          remote: shown(c.remote, c.kind),
          winner: c.winner,
          ...(c.localAt !== undefined ? { localAt: c.localAt } : {}),
          ...(c.remoteAt !== undefined ? { remoteAt: c.remoteAt } : {}),
        }),
      ),
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
      this.store.saveBase(method.id, plan.outgoing)
      plan.saveSecretBase()
      const next = plan.state(version)
      this.store.saveState(next)
      const error = plan.invalid.length ? `invalid-json:${plan.invalid.join(',')}` : undefined
      this.last = this.statusOf(next, error)
      return { status: this.last, pulledSettings }
    }
    return this.fail(state, 'busy')
  }

  async resolve(id: string): Promise<SyncStatus> {
    const method = this.deps.method()
    if (!method) return OFF
    const state = this.store.loadState(method.id)
    const conflict = state.conflicts.find((c) => c.id === id)
    if (!conflict) return this.status()
    if (conflict.kind === 'secret') {
      if (!(await this.deps.secrets?.resolve(id))) return this.status()
      return (await this.run()).status
    }
    const other = conflict.winner === 'local' ? conflict.remote : conflict.local
    const time = this.now().getTime()
    if (conflict.kind === 'setting') {
      const local = this.store.readLocal()
      if (local.settingsInvalid) return this.status()
      const next = withValueAt(
        local.settings ?? {},
        keyPath(id.slice('setting:'.length)),
        other?.value,
      )
      const path = this.store.path(SETTINGS_FILE)
      writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
      stamp(path, time)
    } else {
      const path = join(this.deps.configDir, id.slice('file:'.length))
      if (other === null) removeRegularFile(path)
      else {
        writeFileAtomic(path, String(other.value))
        stamp(path, time)
      }
    }
    this.store.saveState({ ...state, conflicts: state.conflicts.filter((c) => c.id !== id) })
    return (await this.run()).status
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
