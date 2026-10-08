import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretReveal, SecretSyncStatus } from '../../shared/types'
import type { CredentialStore } from '../credentials'
import { type SecretStoreDeps, sanitizeSecrets } from '../extensionSecrets'
import { BASE_DIR } from './engine'
import { mergeMaps } from './merge'
import { isObject, writeAtomic } from './profile'
import {
  type BundleHeader,
  newDataKey,
  newHeader,
  newRecoveryKey,
  normalizeRecoveryKey,
  openBundle,
  parseHeader,
  sealBundle,
  unwrapKey,
  withPassword,
} from './secretCrypto'

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
}

export type SecretResult = { ok: true } | { ok: false; error: string }
export type SetupResult = { ok: true; recoveryKey: string } | { ok: false; error: string }

export interface SecretConflict {
  id: string
  key: string
  winner: 'local' | 'remote'
  localAt: number
  remoteAt: number
}

export interface SecretPlan {
  outgoing: string | null | undefined
  apply: () => void
  saveBase: () => void
  status: SecretSyncStatus
  conflicts: SecretConflict[] | null
}

const SECRET_STATE_FILE = 'secret-sync.json'
const SECRET_BASE_FILE = 'secrets.bin'
const PASSWORD_MIN = 12

type Pending = 'create' | 'rewrap' | 'reset' | 'remove' | null

interface StoredSecretConflict extends SecretConflict {
  winnerMac: string
  local: string | null
  remote: string | null
}

interface LocalState {
  enabled: boolean
  logins: boolean
  header: BundleHeader | null
  key: string | null
  pending: Pending
  conflicts: StoredSecretConflict[]
}

const OFF_STATE: LocalState = {
  enabled: false,
  logins: false,
  header: null,
  key: null,
  pending: null,
  conflicts: [],
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
  if (!isObject(raw) || !isObject(raw.entries)) return null
  const out = new Map<string, SecretEntry>()
  for (const [id, value] of Object.entries(raw.entries)) {
    if (!id.includes(SEP) || !isObject(value)) continue
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
      if (!isObject(raw)) return { ...OFF_STATE }
      const pending = ['create', 'rewrap', 'reset', 'remove'].includes(raw.pending as string)
        ? (raw.pending as Pending)
        : null
      return {
        enabled: raw.enabled === true,
        logins: raw.logins === true,
        header: parseHeader(raw.header),
        key: typeof raw.key === 'string' ? raw.key : null,
        pending,
        conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as StoredSecretConflict[]) : [],
      }
    } catch {
      return { ...OFF_STATE }
    }
  }

  private save(state: LocalState): void {
    writeAtomic(this.statePath(), `${JSON.stringify(state)}\n`)
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
      if (!isObject(raw) || raw.keyId !== keyId || !isObject(raw.entries)) return null
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
    this.save({ ...state, enabled: true, header, key: this.keep(dataKey), pending, conflicts: [] })
    return { ok: true, recoveryKey }
  }

  async unlock(password: string): Promise<SecretResult> {
    const remote = await this.remote()
    if (remote === undefined) return { ok: false, error: 'no-bundle' }
    if (remote === null) return { ok: false, error: 'damaged' }
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
    if (!state.enabled || !state.header || !dataKey) return { ok: false, error: 'locked' }
    const header = await withPassword(state.header, dataKey, password)
    this.save({ ...state, header, pending: 'rewrap' })
    return { ok: true }
  }

  async enable(): Promise<void> {
    this.save({ ...this.load(), enabled: true })
  }

  async setLogins(on: boolean): Promise<void> {
    this.save({ ...this.load(), logins: on })
  }

  private opened(kept: string | null): string | null {
    return kept === null ? null : this.deps.protect.decrypt(kept)
  }

  async reveal(id: string): Promise<SecretReveal> {
    const conflict = this.load().conflicts.find((c) => c.id === id)
    if (!conflict) return { ok: false }
    try {
      return {
        ok: true,
        local: this.opened(conflict.local),
        remote: this.opened(conflict.remote),
        winner: conflict.winner,
      }
    } catch {
      return { ok: false }
    }
  }

  async resolve(id: string): Promise<boolean> {
    const state = this.load()
    const conflict = state.conflicts.find((c) => c.id === id)
    if (!conflict) return false
    const entry = id.slice('secret:'.length)
    const source = this.deps.sources().find((s) => s.name === sourceOf(entry))
    if (!source) return false
    let other: string | null
    try {
      other = this.opened(conflict.winner === 'local' ? conflict.remote : conflict.local)
    } catch {
      return false
    }
    source.write(new Map([[keyOf(entry), other]]))
    this.save({ ...state, conflicts: state.conflicts.filter((c) => c.id !== id) })
    return true
  }

  async disable(): Promise<void> {
    const state = this.load()
    this.save({ ...OFF_STATE, logins: state.logins })
  }

  async remove(): Promise<void> {
    this.save({ ...this.load(), enabled: true, pending: 'remove' })
  }

  statusOf(state = this.load(), damaged = false): SecretSyncStatus {
    if (!state.enabled) return { state: 'off', logins: state.logins }
    if (damaged) return { state: 'damaged', logins: state.logins }
    if (!state.header || !this.dataKey(state)) return { state: 'locked', logins: state.logins }
    return { state: 'unlocked', logins: state.logins }
  }

  status(): SecretSyncStatus {
    return this.statusOf()
  }

  async plan(remoteText: string | undefined): Promise<SecretPlan> {
    const state = this.load()
    const carry = (status: SecretSyncStatus): SecretPlan => ({
      outgoing: undefined,
      apply: () => {},
      saveBase: () => {},
      status,
      conflicts: null,
    })
    if (!state.enabled) return carry(this.statusOf(state))
    if (state.pending === 'remove') {
      return {
        outgoing: null,
        apply: () => this.save({ ...OFF_STATE, logins: state.logins }),
        saveBase: () => {},
        status: { state: 'off', logins: state.logins },
        conflicts: [],
      }
    }
    const remote = remoteText === undefined ? undefined : openBundle(remoteText)
    if (remote === null) return carry(this.statusOf(state, true))
    const dataKey = this.dataKey(state)
    if (!dataKey || !state.header) {
      return carry({ state: remote ? 'locked' : 'needs-setup', logins: state.logins })
    }
    const lock = (): SecretPlan => {
      const next = { ...state, header: null, key: null, pending: null }
      this.save(next)
      return carry({ state: remote ? 'locked' : 'needs-setup', logins: state.logins })
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

    const mac = (value: string | undefined): string =>
      createHmac('sha256', dataKey)
        .update(value ?? '')
        .digest('base64')
    const describe = (id: string): string =>
      included.find((s) => s.name === sourceOf(id))?.describe(keyOf(id)) ?? keyOf(id)
    const kept = (value: string | undefined): string | null =>
      value === undefined ? null : this.deps.protect.encrypt(value)
    const fresh: StoredSecretConflict[] = merge.conflicts.map((c) => ({
      id: `secret:${c.key}`,
      key: describe(c.key),
      winner: c.winner,
      localAt: local.get(c.key)?.at ?? 0,
      remoteAt: remoteIncluded.get(c.key)?.at ?? 0,
      winnerMac: mac(merge.merged.get(c.key)),
      local: kept(c.local),
      remote: kept(c.remote),
    }))
    const conflicts = [
      ...state.conflicts.filter(
        (c) =>
          !fresh.some((f) => f.id === c.id) &&
          c.winnerMac === mac(merge.merged.get(c.id.slice('secret:'.length))),
      ),
      ...fresh,
    ]

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
        this.save({ ...state, pending: null, conflicts })
      },
      saveBase: () => {
        const body = JSON.stringify({
          keyId: header.keyId,
          entries: Object.fromEntries(merge.merged),
        })
        writeAtomic(this.basePath(), this.deps.protect.encrypt(body))
      },
      status: { state: 'unlocked', logins: state.logins },
      conflicts: conflicts.map(({ id, key, winner, localAt, remoteAt }) => ({
        id,
        key,
        winner,
        localAt,
        remoteAt,
      })),
    }
  }
}

function mtimeOr(mtime: () => number): number {
  try {
    return mtime()
  } catch {
    return 0
  }
}

export function groupedSource(
  name: Exclude<SecretSourceName, 'vault' | 'logins'>,
  store: SecretStoreDeps,
  mtime: () => number,
): SecretSource {
  return {
    name,
    read: () => {
      const out = new Map<string, SecretEntry>()
      if (!store.canEncrypt()) return out
      const at = mtimeOr(mtime)
      for (const [group, values] of Object.entries(sanitizeSecrets(store.load()))) {
        for (const [key, kept] of Object.entries(values)) {
          try {
            out.set(JSON.stringify([group, key]), { value: store.decrypt(kept), at })
          } catch {}
        }
      }
      return out
    },
    write: (changes) => {
      const data = sanitizeSecrets(store.load())
      for (const [id, value] of changes) {
        const [group, key] = JSON.parse(id) as [string, string]
        const values = { ...(data[group] ?? {}) }
        if (value === null) delete values[key]
        else values[key] = store.encrypt(value)
        if (Object.keys(values).length === 0) delete data[group]
        else data[group] = values
      }
      store.save({ ...data })
    },
    describe: (id) => (JSON.parse(id) as [string, string]).join(': '),
  }
}

export function flatSource(store: SecretStoreDeps, mtime: () => number): SecretSource {
  const load = (): Record<string, string> => {
    const raw = store.load()
    if (!isObject(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  }
  return {
    name: 'vault',
    read: () => {
      const out = new Map<string, SecretEntry>()
      if (!store.canEncrypt()) return out
      const at = mtimeOr(mtime)
      for (const [key, kept] of Object.entries(load())) {
        try {
          out.set(key, { value: store.decrypt(kept), at })
        } catch {}
      }
      return out
    },
    write: (changes) => {
      const data = load()
      for (const [key, value] of changes) {
        if (value === null) delete data[key]
        else data[key] = store.encrypt(value)
      }
      store.save(data as never)
    },
    describe: (key) => key,
  }
}

export function loginsSource(store: CredentialStore): SecretSource {
  return {
    name: 'logins',
    read: () => {
      const out = new Map<string, SecretEntry>()
      for (const login of store.list()) {
        const password = store.password(login.id)
        if (password === null) continue
        out.set(JSON.stringify([login.origin, login.username]), {
          value: password,
          at: login.updatedAt,
        })
      }
      return out
    },
    write: (changes) => {
      const byKey = new Map(
        store.list().map((login) => [JSON.stringify([login.origin, login.username]), login.id]),
      )
      for (const [key, value] of changes) {
        const [origin, username] = JSON.parse(key) as [string, string]
        if (value === null) {
          const id = byKey.get(key)
          if (id) store.remove(id)
        } else store.save({ origin, username, password: value })
      }
    },
    describe: (key) => {
      const [origin, username] = JSON.parse(key) as [string, string]
      return `${origin} (${username})`
    },
  }
}
