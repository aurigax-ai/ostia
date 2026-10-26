import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { SecretSyncStatus } from '../../shared/profileSync/profileSync'
import { mergeMaps } from './merge'
import {
  type BundleHeader,
  newDataKey,
  newHeader,
  newRecoveryKey,
  newSyncKeyHeader,
  normalizeRecoveryKey,
  type OpenedBundle,
  openBundle,
  parseHeader,
  sealBundle,
  syncKeyDataKey,
  unwrapKey,
  usesSyncKey,
  withPassword,
} from './secretCrypto'
import { BASE_DIR } from './syncStore'

export type SecretSourceName = 'vault' | 'extensions' | 'assistant' | 'mcp' | 'logins'

export interface SecretEntry {
  value: string
  at: number
}

export interface SecretSource {
  name: SecretSourceName
  read: () => Map<string, SecretEntry>
  write: (changes: Map<string, string | null>) => void
  describe: (key: string) => string
}

export interface Protect {
  encrypt: (plain: string) => string
  decrypt: (kept: string) => string
}

export interface SecretSyncDeps {
  userData: string
  protect: Protect
  sources: () => SecretSource[]
  readRemote: () => Promise<string | undefined>
  syncKey: () => Buffer | null
}

export type SecretResult = { ok: true } | { ok: false; error: string }
export type SetupResult = { ok: true; recoveryKey: string } | { ok: false; error: string }

export interface SecretPlan {
  outgoing: string | null | undefined
  apply: () => void
  saveBase: () => void
  status: SecretSyncStatus
}

const SECRET_STATE_FILE = 'secret-sync.json'
const SECRET_BASE_FILE = 'secrets.bin'
const PASSWORD_MIN = 12

type Pending = 'create' | 'rewrap' | 'reset' | null

interface LocalState {
  enabled: boolean
  logins: boolean
  header: BundleHeader | null
  key: string | null
  pending: Pending
}

const OFF_STATE: LocalState = {
  enabled: false,
  logins: false,
  header: null,
  key: null,
  pending: null,
}

const SEP = '\0'
const entryId = (source: SecretSourceName, key: string): string => `${source}${SEP}${key}`
const sourceOf = (id: string): string => id.slice(0, id.indexOf(SEP))
const keyOf = (id: string): string => id.slice(id.indexOf(SEP) + 1)

function checkPassword(password: string, confirm: string): string | null {
  if ([...password].length < PASSWORD_MIN) return 'too-short'
  if (password !== confirm) return 'mismatch'
  return null
}

function parsePayload(text: string): Map<string, SecretEntry> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !isRecord(raw.entries)) return null
  const out = new Map<string, SecretEntry>()
  for (const [id, value] of Object.entries(raw.entries)) {
    if (!id.includes(SEP) || !isRecord(value)) continue
    if (typeof value.value !== 'string' || typeof value.at !== 'number') continue
    out.set(id, { value: value.value, at: value.at })
  }
  return out
}

const payloadOf = (entries: ReadonlyMap<string, SecretEntry>): string =>
  JSON.stringify({
    entries: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
  })

const sameEntries = (
  a: ReadonlyMap<string, SecretEntry>,
  b: ReadonlyMap<string, SecretEntry>,
): boolean =>
  a.size === b.size &&
  [...a].every(([id, e]) => b.get(id)?.value === e.value && b.get(id)?.at === e.at)

export class SecretSync {
  constructor(private readonly deps: SecretSyncDeps) {}

  private statePath(): string {
    return join(this.deps.userData, SECRET_STATE_FILE)
  }

  private basePath(): string {
    return join(this.deps.userData, BASE_DIR, SECRET_BASE_FILE)
  }

  private load(): LocalState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), 'utf8')) as unknown
      if (!isRecord(raw)) return { ...OFF_STATE }
      const pending = ['create', 'rewrap', 'reset'].includes(raw.pending as string)
        ? (raw.pending as Pending)
        : null
      return {
        enabled: raw.enabled === true,
        logins: raw.logins === true,
        header: parseHeader(raw.header),
        key: typeof raw.key === 'string' ? raw.key : null,
        pending,
      }
    } catch {
      return { ...OFF_STATE }
    }
  }

  private save(state: LocalState): void {
    writeFileAtomic(this.statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 })
  }

  private dataKey(state: LocalState): Buffer | null {
    if (!state.key) return null
    try {
      const key = Buffer.from(this.deps.protect.decrypt(state.key), 'base64')
      return key.length === 32 ? key : null
    } catch {
      return null
    }
  }

  private keep(dataKey: Buffer): string {
    return this.deps.protect.encrypt(dataKey.toString('base64'))
  }

  private loadBase(keyId: string): Map<string, string> | null {
    try {
      const raw = JSON.parse(
        this.deps.protect.decrypt(readFileSync(this.basePath(), 'utf8')),
      ) as unknown
      if (!isRecord(raw) || raw.keyId !== keyId || !isRecord(raw.entries)) return null
      const out = new Map<string, string>()
      for (const [id, value] of Object.entries(raw.entries)) {
        if (typeof value === 'string') out.set(id, value)
      }
      return out
    } catch {
      return null
    }
  }

  private async remote() {
    const text = await this.deps.readRemote()
    return text === undefined ? undefined : openBundle(text)
  }

  async setup(password: string, confirm: string): Promise<SetupResult> {
    const problem = checkPassword(password, confirm)
    if (problem) return { ok: false, error: problem }
    if ((await this.deps.readRemote()) !== undefined) return { ok: false, error: 'exists' }
    return this.create(password, 'create')
  }

  async reset(password: string, confirm: string): Promise<SetupResult> {
    const problem = checkPassword(password, confirm)
    if (problem) return { ok: false, error: problem }
    return this.create(password, 'reset')
  }

  private async create(password: string, pending: 'create' | 'reset'): Promise<SetupResult> {
    const dataKey = newDataKey()
    const recoveryKey = newRecoveryKey()
    const header = await newHeader(dataKey, password, recoveryKey)
    const state = this.load()
    this.save({ ...state, enabled: true, header, key: this.keep(dataKey), pending })
    return { ok: true, recoveryKey }
  }

  private syncKeyState(pending: 'create' | 'reset'): LocalState | null {
    const syncKey = this.deps.syncKey()
    if (!syncKey) return null
    return {
      ...this.load(),
      enabled: true,
      header: newSyncKeyHeader(),
      key: this.keep(syncKeyDataKey(syncKey)),
      pending,
    }
  }

  async useSyncKey(): Promise<SecretResult> {
    const next = this.syncKeyState('reset')
    if (!next) return { ok: false, error: 'locked' }
    this.save(next)
    return { ok: true }
  }

  async unlock(password: string): Promise<SecretResult> {
    const remote = await this.remote()
    if (remote === undefined) return { ok: false, error: 'no-bundle' }
    if (remote === null) return { ok: false, error: 'damaged' }
    if (usesSyncKey(remote.header)) return { ok: false, error: 'failed' }
    const dataKey = await unwrapKey(remote.header.password, password, remote.header.kdf)
    if (!dataKey) return { ok: false, error: 'wrong-password' }
    const state = this.load()
    this.save({
      ...state,
      enabled: true,
      header: remote.header,
      key: this.keep(dataKey),
      pending: null,
    })
    return { ok: true }
  }

  async recover(recoveryKey: string, password: string, confirm: string): Promise<SecretResult> {
    const problem = checkPassword(password, confirm)
    if (problem) return { ok: false, error: problem }
    const remote = await this.remote()
    if (remote === undefined) return { ok: false, error: 'no-bundle' }
    if (remote === null) return { ok: false, error: 'damaged' }
    if (usesSyncKey(remote.header)) return { ok: false, error: 'failed' }
    const dataKey = await unwrapKey(
      remote.header.recovery,
      normalizeRecoveryKey(recoveryKey),
      remote.header.kdf,
    )
    if (!dataKey) return { ok: false, error: 'wrong-recovery-key' }
    const header = await withPassword(remote.header, dataKey, password)
    const state = this.load()
    this.save({ ...state, enabled: true, header, key: this.keep(dataKey), pending: 'rewrap' })
    return { ok: true }
  }

  async changePassword(password: string, confirm: string): Promise<SecretResult> {
    const problem = checkPassword(password, confirm)
    if (problem) return { ok: false, error: problem }
    const state = this.load()
    const dataKey = this.dataKey(state)
    if (!state.enabled || !state.header || usesSyncKey(state.header) || !dataKey) {
      return { ok: false, error: 'locked' }
    }
    const header = await withPassword(state.header, dataKey, password)
    this.save({ ...state, header, pending: 'rewrap' })
    return { ok: true }
  }

  async setLogins(on: boolean): Promise<void> {
    this.save({ ...this.load(), logins: on })
  }

  async enable(): Promise<void> {
    const state = this.load()
    this.save(
      state.header
        ? { ...state, enabled: true }
        : (this.syncKeyState('create') ?? { ...state, enabled: true }),
    )
  }

  async disable(): Promise<void> {
    const state = this.load()
    this.save({ ...OFF_STATE, logins: state.logins })
  }

  private modeOf(header: BundleHeader | null | undefined): SecretSyncStatus['mode'] {
    if (header) return usesSyncKey(header) ? 'sync-key' : 'password'
    return this.deps.syncKey() ? 'sync-key' : 'password'
  }

  statusOf(state = this.load(), damaged = false): SecretSyncStatus {
    const base = { mode: this.modeOf(state.header), logins: state.logins }
    if (!state.enabled) return { state: 'off', ...base }
    if (damaged) return { state: 'damaged', ...base }
    if (!state.header || !this.dataKey(state)) return { state: 'locked', ...base }
    return { state: 'unlocked', ...base }
  }

  private adopted(state: LocalState, remote: OpenedBundle | undefined): LocalState | 'damaged' {
    const syncKey = this.deps.syncKey()
    if (!remote || !usesSyncKey(remote.header) || !syncKey || state.pending === 'reset') {
      return state
    }
    if (state.header?.keyId === remote.header.keyId) return state
    const dataKey = syncKeyDataKey(syncKey)
    if (remote.open(dataKey) === null) return 'damaged'
    const next = { ...state, header: remote.header, key: this.keep(dataKey), pending: null }
    this.save(next)
    return next
  }

  status(): SecretSyncStatus {
    return this.statusOf()
  }

  async plan(remoteText: string | undefined): Promise<SecretPlan> {
    const loaded = this.load()
    const carry = (status: SecretSyncStatus): SecretPlan => ({
      outgoing: undefined,
      apply: () => {},
      saveBase: () => {},
      status,
    })
    if (!loaded.enabled) return carry(this.statusOf(loaded))
    const remote = remoteText === undefined ? undefined : openBundle(remoteText)
    if (remote === null) return carry(this.statusOf(loaded, true))
    const state = this.adopted(loaded, remote)
    if (state === 'damaged') return carry(this.statusOf(loaded, true))
    const waiting = (): SecretSyncStatus => ({
      state: remote ? 'locked' : 'needs-setup',
      mode: this.modeOf(remote?.header),
      logins: state.logins,
    })
    const dataKey = this.dataKey(state)
    if (!dataKey || !state.header) return carry(waiting())
    const lock = (): SecretPlan => {
      this.save({ ...state, header: null, key: null, pending: null })
      return carry(waiting())
    }
    const header = state.header
    let remoteEntries = new Map<string, SecretEntry>()
    let base: Map<string, string> | null = null
    if (state.pending !== 'reset') {
      if (remote === undefined) {
        if (state.pending !== 'create') return lock()
      } else {
        if (remote.header.keyId !== header.keyId) return lock()
        if (remote.header.wrapId !== header.wrapId && state.pending !== 'rewrap') return lock()
        const plain = remote.open(dataKey)
        const parsed = plain === null ? null : parsePayload(plain)
        if (!parsed) return carry(this.statusOf(state, true))
        remoteEntries = parsed
        base = this.loadBase(header.keyId)
      }
    }

    const included = this.deps
      .sources()
      .filter((source) => source.name !== 'logins' || state.logins)
    const includes = (id: string): boolean => included.some((s) => s.name === sourceOf(id))
    const local = new Map<string, SecretEntry>()
    for (const source of included) {
      for (const [key, entry] of source.read()) local.set(entryId(source.name, key), entry)
    }
    const remoteIncluded = new Map([...remoteEntries].filter(([id]) => includes(id)))
    const merge = mergeMaps(
      base ? new Map([...base].filter(([id]) => includes(id))) : null,
      new Map([...local].map(([id, e]) => [id, e.value])),
      new Map([...remoteIncluded].map(([id, e]) => [id, e.value])),
      (a, b) => a === b,
      (id) => ((local.get(id)?.at ?? 0) > (remoteIncluded.get(id)?.at ?? 0) ? 'local' : 'remote'),
    )
    const outgoing = new Map<string, SecretEntry>()
    for (const [id, entry] of remoteEntries) if (!includes(id)) outgoing.set(id, entry)
    for (const [id, value] of merge.merged) {
      const from = local.get(id)?.value === value ? local.get(id) : remoteIncluded.get(id)
      outgoing.set(id, { value, at: from?.at ?? 0 })
    }

    const unchanged =
      remote !== undefined &&
      state.pending === null &&
      sameEntries(outgoing, remoteEntries) &&
      remote.header.wrapId === header.wrapId
    return {
      outgoing: unchanged ? undefined : sealBundle(header, dataKey, payloadOf(outgoing)),
      apply: () => {
        for (const source of included) {
          const changes = new Map<string, string | null>()
          const prefix = `${source.name}${SEP}`
          const ids = new Set([...local.keys(), ...merge.merged.keys()])
          for (const id of ids) {
            if (!id.startsWith(prefix)) continue
            const want = merge.merged.get(id)
            if (want !== local.get(id)?.value) changes.set(keyOf(id), want ?? null)
          }
          if (changes.size > 0) source.write(changes)
        }
        this.save({ ...state, pending: null })
      },
      saveBase: () => {
        const body = JSON.stringify({
          keyId: header.keyId,
          entries: Object.fromEntries(merge.merged),
        })
        writeFileAtomic(this.basePath(), this.deps.protect.encrypt(body), { mode: 0o600 })
      },
      status: { state: 'unlocked', mode: this.modeOf(header), logins: state.logins },
    }
  }
}
