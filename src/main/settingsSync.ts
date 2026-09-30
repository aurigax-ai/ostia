import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { SyncConflict, SyncStatus } from '../shared/types'

export const SETTINGS_FILE = 'settings.json'
export const EXTENSIONS_FILE = 'extensions.json'
export const SYNC_STATE_FILE = 'sync-state.json'
export const SETTINGS_LOCAL_ONLY_KEYS = ['sync', 'capabilities', 'approvals'] as const

export interface SyncedFileSpec {
  name: string
  localOnlyKeys: readonly string[]
}

export const SYNCED_FILES: readonly SyncedFileSpec[] = [
  { name: SETTINGS_FILE, localOnlyKeys: SETTINGS_LOCAL_ONLY_KEYS },
  { name: EXTENSIONS_FILE, localOnlyKeys: [] },
]

export interface SideState {
  hash: string | null
  mtimeMs: number
}

export type SyncPlan =
  | { kind: 'noop' }
  | { kind: 'push' }
  | { kind: 'pull' }
  | { kind: 'conflict'; winner: 'local' | 'remote' }

type JsonObject = Record<string, unknown>

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function syncedPart(value: JsonObject, localOnlyKeys: readonly string[]): JsonObject {
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(value)) {
    if (!localOnlyKeys.includes(k)) out[k] = v
  }
  return out
}

export function mergeIntoLocal(
  local: JsonObject | null,
  remote: JsonObject,
  localOnlyKeys: readonly string[],
): JsonObject {
  const out = syncedPart(remote, localOnlyKeys)
  if (local) {
    for (const k of localOnlyKeys) if (k in local) out[k] = local[k]
  }
  return out
}

export function planSync(local: SideState, remote: SideState, base: string | null): SyncPlan {
  if (local.hash === null && remote.hash === null) return { kind: 'noop' }
  if (local.hash === null) return { kind: 'pull' }
  if (remote.hash === null) return { kind: 'push' }
  if (local.hash === remote.hash) return { kind: 'noop' }
  const localChanged = local.hash !== base
  const remoteChanged = remote.hash !== base
  if (localChanged && !remoteChanged) return { kind: 'push' }
  if (remoteChanged && !localChanged) return { kind: 'pull' }
  return { kind: 'conflict', winner: remote.mtimeMs > local.mtimeMs ? 'remote' : 'local' }
}

export function conflictName(file: string, now: Date, host: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safeHost = host.replace(/[^A-Za-z0-9_-]/g, '_') || 'host'
  return `${file.replace(/\.json$/, '')}.conflict-${stamp}-${safeHost}.json`
}

export function expandSyncDir(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const trimmed = raw.trim()
  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/')
        ? join(homedir(), trimmed.slice(2))
        : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : null
}

interface PersistedSyncState {
  dir: string
  files: Record<string, string>
  lastSync: string | null
  lastConflict: SyncConflict | null
}

interface ReadSide {
  value: JsonObject | null
  mtimeMs: number
  invalid: boolean
}

function readSide(path: string): ReadSide {
  if (!existsSync(path)) return { value: null, mtimeMs: 0, invalid: false }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isObject(value)) return { value: null, mtimeMs: 0, invalid: true }
    return { value, mtimeMs: statSync(path).mtimeMs, invalid: false }
  } catch {
    return { value: null, mtimeMs: 0, invalid: true }
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

export interface SettingsSyncOptions {
  userData: string
  host: string
  now?: () => Date
}

export interface SyncRunResult {
  status: SyncStatus
  pulled: string[]
}

const OFF: SyncStatus = { dir: null, state: 'off', lastSync: null, lastConflict: null }

export class SettingsSync {
  private last: SyncStatus = OFF

  constructor(private readonly opts: SettingsSyncOptions) {}

  private statePath(): string {
    return join(this.opts.userData, SYNC_STATE_FILE)
  }

  private loadState(dir: string): PersistedSyncState {
    const fresh: PersistedSyncState = { dir, files: {}, lastSync: null, lastConflict: null }
    try {
      const raw = JSON.parse(readFileSync(this.statePath(), 'utf8')) as PersistedSyncState
      if (!raw || raw.dir !== dir || !isObject(raw.files)) return fresh
      return {
        dir,
        files: raw.files as Record<string, string>,
        lastSync: typeof raw.lastSync === 'string' ? raw.lastSync : null,
        lastConflict: raw.lastConflict ?? null,
      }
    } catch {
      return fresh
    }
  }

  private statusFrom(state: PersistedSyncState): SyncStatus {
    return {
      dir: state.dir,
      state: 'ok',
      lastSync: state.lastSync,
      lastConflict: state.lastConflict,
    }
  }

  configuredDir(): string | null {
    const settings = readSide(join(this.opts.userData, SETTINGS_FILE)).value
    const sync = settings && isObject(settings.sync) ? settings.sync : null
    return expandSyncDir(sync?.dir)
  }

  status(): SyncStatus {
    const dir = this.configuredDir()
    if (!dir) return OFF
    if (this.last.dir === dir) return this.last
    return this.statusFrom(this.loadState(dir))
  }

  run(): SyncRunResult {
    const dir = this.configuredDir()
    if (!dir) {
      this.last = OFF
      return { status: this.last, pulled: [] }
    }
    const fail = (error: string): SyncRunResult => {
      this.last = { ...this.statusFrom(this.loadState(dir)), state: 'error', error }
      return { status: this.last, pulled: [] }
    }
    if (resolve(dir) === resolve(this.opts.userData)) return fail('same-as-local')
    try {
      if (!statSync(dir).isDirectory()) return fail('not-a-directory')
    } catch {
      return fail('missing')
    }

    const now = (this.opts.now ?? (() => new Date()))()
    const state = this.loadState(dir)
    const pulled: string[] = []
    const conflicts: string[] = []
    const invalid: string[] = []

    for (const spec of SYNCED_FILES) {
      const localPath = join(this.opts.userData, spec.name)
      const remotePath = join(dir, spec.name)
      const local = readSide(localPath)
      const remote = readSide(remotePath)
      if (local.invalid || remote.invalid) {
        invalid.push(spec.name)
        continue
      }
      const localSynced = local.value ? syncedPart(local.value, spec.localOnlyKeys) : null
      const remoteSynced = remote.value ? syncedPart(remote.value, spec.localOnlyKeys) : null
      const plan = planSync(
        { hash: localSynced ? hashOf(localSynced) : null, mtimeMs: local.mtimeMs },
        { hash: remoteSynced ? hashOf(remoteSynced) : null, mtimeMs: remote.mtimeMs },
        state.files[spec.name] ?? null,
      )
      const push = (): void => {
        if (localSynced) writeJsonAtomic(remotePath, localSynced)
      }
      const pull = (): void => {
        if (!remoteSynced) return
        mkdirSync(this.opts.userData, { recursive: true })
        writeJsonAtomic(localPath, mergeIntoLocal(local.value, remoteSynced, spec.localOnlyKeys))
        pulled.push(spec.name)
      }
      if (plan.kind === 'push') push()
      else if (plan.kind === 'pull') pull()
      else if (plan.kind === 'conflict') {
        const copy = conflictName(spec.name, now, this.opts.host)
        writeJsonAtomic(join(dir, copy), plan.winner === 'remote' ? localSynced : remoteSynced)
        conflicts.push(copy)
        if (plan.winner === 'remote') pull()
        else push()
      }
      const synced = plan.kind === 'pull' || (plan.kind === 'conflict' && plan.winner === 'remote')
      const kept = synced ? remoteSynced : (localSynced ?? remoteSynced)
      if (kept) state.files[spec.name] = hashOf(kept)
    }

    state.lastSync = now.toISOString()
    if (conflicts.length) state.lastConflict = { at: state.lastSync, files: conflicts }
    try {
      writeJsonAtomic(this.statePath(), state)
    } catch {}
    this.last = this.statusFrom(state)
    if (invalid.length) {
      this.last.state = 'error'
      this.last.error = `invalid-json:${invalid.join(',')}`
    }
    return { status: this.last, pulled }
  }
}
