import { readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretSpan } from '../../shared/redaction'
import type { SyncConflict, SyncOffer, SyncStatus } from '../../shared/types'
import {
  canonicalJson,
  flatten,
  keyPath,
  mergeMaps,
  sameJson,
  unflatten,
  withValueAt,
} from './merge'
import {
  type JsonObject,
  type Profile,
  SETTINGS_FILE,
  type SyncedExtension,
  decodeProfile,
  encodeProfile,
  isObject,
  offerable,
  readProfileFolders,
  readTopFile,
  removeRegularFile,
  syncedSettings,
  withLocalOnly,
  writeAtomic,
} from './profile'

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
  host: string
  now?: () => Date
  method: () => SyncMethod | null
  targetLabel: () => string | null
  installedExtensions: () => SyncedExtension[]
  builtinIds: () => string[]
  installExtension: (id: string, marketplace: string) => Promise<boolean>
  detectSecrets: DetectSecrets
}

export interface SyncRunResult {
  status: SyncStatus
  pulledSettings: boolean
}

export const STATE_FILE = 'sync-state.json'
export const BASE_DIR = 'sync-base'
export const BASE_FILE = 'base.json'
export const WRITE_ATTEMPTS = 3
const SHOWN_VALUE_MAX = 120

type Held = { value: unknown } | null

interface StoredConflict {
  id: string
  kind: 'setting' | 'file'
  key: string
  local: Held
  remote: Held
  winner: 'local' | 'remote'
}

interface SyncState {
  target: string
  version: string | null
  lastSync: string | null
  conflicts: StoredConflict[]
  offers: SyncOffer[]
  installedAtSync: string[]
  skipped: string[]
  heldBack: string[]
}

interface LocalProfile {
  settings: JsonObject | null
  settingsInvalid: boolean
  settingsTime: number
  files: Map<string, string>
  times: Map<string, number>
  skipped: string[]
}

interface Plan {
  write: boolean
  outgoing: Map<string, string>
  apply: () => boolean
  state: (version: string) => SyncState
  invalid: string[]
}

const OFF: SyncStatus = {
  dir: null,
  state: 'off',
  lastSync: null,
  conflicts: [],
  skipped: [],
  heldBack: [],
  offers: [],
}

const held = (value: unknown): Held => (value === undefined ? null : { value })

const shown = (value: Held, kind: StoredConflict['kind']): string | null => {
  if (value === null) return null
  const text = kind === 'setting' ? JSON.stringify(value.value) : String(value.value)
  return text.length > SHOWN_VALUE_MAX ? `${text.slice(0, SHOWN_VALUE_MAX)}…` : text
}

const sameFiles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([path, text]) => b.get(path) === text)

const stamp = (path: string, time: number): void => {
  try {
    const at = new Date(time)
    utimesSync(path, at, at)
  } catch {}
}

class ScanFailed extends Error {}

export class ProfileSync {
  private last: SyncStatus = OFF
  private running: Promise<SyncRunResult> | null = null

  constructor(private readonly deps: ProfileSyncDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  private path(...parts: string[]): string {
    return join(this.deps.userData, ...parts)
  }

  private loadState(target: string): SyncState {
    const fresh: SyncState = {
      target,
      version: null,
      lastSync: null,
      conflicts: [],
      offers: [],
      installedAtSync: [],
      skipped: [],
      heldBack: [],
    }
    try {
      const raw = JSON.parse(readFileSync(this.path(STATE_FILE), 'utf8')) as SyncState
      if (!isObject(raw) || raw.target !== target) return fresh
      return {
        target,
        version: typeof raw.version === 'string' ? raw.version : null,
        lastSync: typeof raw.lastSync === 'string' ? raw.lastSync : null,
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
        offers: Array.isArray(raw.offers) ? raw.offers : [],
        installedAtSync: Array.isArray(raw.installedAtSync) ? raw.installedAtSync : [],
        skipped: Array.isArray(raw.skipped) ? raw.skipped : [],
        heldBack: Array.isArray(raw.heldBack) ? raw.heldBack : [],
      }
    } catch {
      return fresh
    }
  }

  private saveState(state: SyncState): void {
    writeAtomic(this.path(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
  }

  private loadBase(target: string): Map<string, string> | null {
    try {
      const raw = JSON.parse(readFileSync(this.path(BASE_DIR, BASE_FILE), 'utf8')) as unknown
      if (!isObject(raw) || raw.target !== target || !isObject(raw.files)) return null
      const files = new Map<string, string>()
      for (const [path, text] of Object.entries(raw.files)) {
        if (typeof text === 'string') files.set(path, text)
      }
      return files
    } catch {
      return null
    }
  }

  private saveBase(target: string, files: ReadonlyMap<string, string>): void {
    const body = { target, files: Object.fromEntries(files) }
    writeAtomic(this.path(BASE_DIR, BASE_FILE), `${JSON.stringify(body)}\n`)
  }

  private readLocal(): LocalProfile {
    const top = readTopFile(this.path(SETTINGS_FILE))
    let settings: JsonObject | null = null
    let settingsInvalid = top === 'skipped'
    let settingsTime = 0
    if (top && top !== 'skipped') {
      settingsTime = top.mtimeMs
      try {
        const parsed = JSON.parse(top.text) as unknown
        if (isObject(parsed)) settings = parsed
        else settingsInvalid = true
      } catch {
        settingsInvalid = true
      }
    }
    const folders = readProfileFolders(this.deps.configDir)
    return {
      settings,
      settingsInvalid,
      settingsTime,
      files: folders.files,
      times: folders.times,
      skipped: folders.skipped,
    }
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
        }),
      ),
      skipped: state.skipped,
      heldBack: state.heldBack,
      offers: state.offers,
    }
  }

  status(): SyncStatus {
    const method = this.deps.method()
    if (!method) return OFF
    if (this.last.dir === this.deps.targetLabel() && this.last.state !== 'off') return this.last
    return this.statusOf(this.loadState(method.id))
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
    const state = this.loadState(method.id)
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let remote: SyncSnapshot
      try {
        remote = await method.read()
      } catch (err) {
        return this.fail(state, err instanceof SyncTargetError ? err.code : 'unreachable')
      }
      let plan: Plan
      try {
        plan = await this.plan(remote, state)
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
      this.saveBase(method.id, plan.outgoing)
      const next = plan.state(version)
      this.saveState(next)
      const error = plan.invalid.length ? `invalid-json:${plan.invalid.join(',')}` : undefined
      this.last = this.statusOf(next, error)
      return { status: this.last, pulledSettings }
    }
    return this.fail(state, 'busy')
  }

  private async heldBackKeys(
    leaves: ReadonlyMap<string, unknown>,
    remote: ReadonlyMap<string, unknown>,
  ): Promise<Set<string>> {
    const changed = [...leaves].filter(([key, value]) => !sameJson(value, remote.get(key)))
    if (changed.length === 0) return new Set()
    const ranges: { key: string; start: number; end: number }[] = []
    let text = ''
    for (const [key, value] of changed) {
      const start = text.length
      text += canonicalJson(value)
      ranges.push({ key, start, end: text.length })
      text += '\n'
    }
    let spans: SecretSpan[]
    try {
      spans = await this.deps.detectSecrets(text)
    } catch {
      throw new ScanFailed()
    }
    const out = new Set<string>()
    for (const span of spans) {
      for (const range of ranges) {
        if (span.start < range.end && span.end > range.start) out.add(range.key)
      }
    }
    return out
  }

  private async plan(remote: SyncSnapshot, state: SyncState): Promise<Plan> {
    const local = this.readLocal()
    const theirs = decodeProfile(remote.files)
    const baseFiles = this.loadBase(state.target)
    const base: Profile | null = baseFiles ? decodeProfile(baseFiles) : null
    const builtin = this.deps.builtinIds()
    const invalid: string[] = []
    const remoteTime = (path: string): number => theirs.times[path] ?? 0

    const settingsStopped = local.settingsInvalid || theirs.settingsInvalid
    if (settingsStopped) invalid.push(SETTINGS_FILE)
    const localSettings = flatten(syncedSettings(local.settings ?? {}))
    const remoteSettings = flatten(syncedSettings(theirs.settings ?? {}))
    const baseSettings = base ? flatten(syncedSettings(base.settings ?? {})) : null
    const settingsWinner = (): 'local' | 'remote' =>
      local.settingsTime > remoteTime(SETTINGS_FILE) ? 'local' : 'remote'
    const settingsMerge = settingsStopped
      ? { merged: remoteSettings, conflicts: [] }
      : mergeMaps(baseSettings, localSettings, remoteSettings, sameJson, settingsWinner)
    const heldKeys = settingsStopped
      ? new Set<string>()
      : await this.heldBackKeys(settingsMerge.merged, remoteSettings)
    const outgoingLeaves = new Map(settingsMerge.merged)
    for (const key of heldKeys) {
      if (remoteSettings.has(key)) outgoingLeaves.set(key, remoteSettings.get(key))
      else outgoingLeaves.delete(key)
    }
    const outgoingSettings =
      outgoingLeaves.size > 0 || remote.files.has(SETTINGS_FILE) || local.settings
        ? unflatten(outgoingLeaves)
        : null

    const localFiles = new Map(local.files)
    const remoteFiles = new Map(theirs.files)
    for (const path of local.skipped) {
      const was = base?.files.get(path)
      if (was !== undefined) localFiles.set(path, was)
    }
    for (const path of remote.skipped) {
      const was = base?.files.get(path)
      if (was !== undefined) remoteFiles.set(path, was)
    }
    const filesMerge = mergeMaps(
      base ? base.files : null,
      localFiles,
      remoteFiles,
      (a, b) => a === b,
      (path, l, r) => {
        if (l === undefined) return 'remote'
        if (r === undefined) return 'local'
        return (local.times.get(path) ?? 0) > remoteTime(path) ? 'local' : 'remote'
      },
    )
    const outgoingFiles = new Map(filesMerge.merged)
    for (const path of remote.skipped) outgoingFiles.delete(path)

    const installed = this.deps.installedExtensions().filter((e) => !builtin.includes(e.id))
    const installedIds = new Set(installed.map((e) => e.id))
    const localExt = new Map(installed.map((e) => [e.id, e.marketplace]))
    for (const e of base?.extensions ?? []) {
      if (!installedIds.has(e.id) && !state.installedAtSync.includes(e.id)) {
        localExt.set(e.id, e.marketplace)
      }
    }
    const remoteExt = new Map(
      theirs.extensions.filter((e) => !builtin.includes(e.id)).map((e) => [e.id, e.marketplace]),
    )
    const baseExt = base ? new Map(base.extensions.map((e) => [e.id, e.marketplace])) : null
    const extMerge = mergeMaps(
      baseExt,
      localExt,
      remoteExt,
      (a, b) => a === b,
      () => 'remote',
    )
    const extensions = [...extMerge.merged].map(([id, marketplace]) => ({ id, marketplace }))

    const times: Record<string, number> = {}
    const settingsSame = sameJson(outgoingSettings ?? {}, syncedSettings(theirs.settings ?? {}))
    times[SETTINGS_FILE] = settingsSame
      ? remoteTime(SETTINGS_FILE)
      : Math.max(local.settingsTime, remoteTime(SETTINGS_FILE))
    for (const [path, text] of outgoingFiles) {
      times[path] =
        theirs.files.get(path) === text ? remoteTime(path) : (local.times.get(path) ?? 0)
    }
    const outgoing = encodeProfile({
      settings: outgoingSettings,
      extensions,
      files: outgoingFiles,
      times,
    })
    if (settingsStopped) {
      const raw = remote.files.get(SETTINGS_FILE)
      if (raw === undefined) outgoing.delete(SETTINGS_FILE)
      else outgoing.set(SETTINGS_FILE, raw)
    }

    const mergedSettingsLeaves = settingsMerge.merged
    const mergedFiles = filesMerge.merged
    const stillCurrent = (c: StoredConflict): boolean => {
      const winner = c.winner === 'local' ? c.local : c.remote
      const now =
        c.kind === 'setting'
          ? mergedSettingsLeaves.get(c.id.slice('setting:'.length))
          : mergedFiles.get(c.id.slice('file:'.length))
      return winner === null ? now === undefined : sameJson(now, winner.value)
    }
    const fresh: StoredConflict[] = [
      ...settingsMerge.conflicts.map(
        (c): StoredConflict => ({
          id: `setting:${c.key}`,
          kind: 'setting',
          key: keyPath(c.key).join('.'),
          local: held(c.local),
          remote: held(c.remote),
          winner: c.winner,
        }),
      ),
      ...filesMerge.conflicts.map(
        (c): StoredConflict => ({
          id: `file:${c.key}`,
          kind: 'file',
          key: c.key,
          local: held(c.local),
          remote: held(c.remote),
          winner: c.winner,
        }),
      ),
    ]
    const conflicts = [
      ...state.conflicts.filter((c) => !fresh.some((f) => f.id === c.id) && stillCurrent(c)),
      ...fresh,
    ]

    const apply = (): boolean => {
      let pulledSettings = false
      if (!settingsStopped) {
        const next = withLocalOnly(unflatten(mergedSettingsLeaves), local.settings ?? {})
        const changed = local.settings
          ? canonicalJson(next) !== canonicalJson(local.settings)
          : Object.keys(next).length > 0
        if (changed) {
          const path = this.path(SETTINGS_FILE)
          writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
          stamp(path, Math.max(local.settingsTime, remoteTime(SETTINGS_FILE)))
          pulledSettings = true
        }
      }
      const paths = new Set([...local.files.keys(), ...mergedFiles.keys()])
      for (const path of paths) {
        if (local.skipped.includes(path)) continue
        const want = mergedFiles.get(path)
        if (want === local.files.get(path)) continue
        const target = join(this.deps.configDir, path)
        if (want === undefined) removeRegularFile(target)
        else {
          writeAtomic(target, want)
          stamp(target, remoteTime(path))
        }
      }
      return pulledSettings
    }

    const offers = extensions.filter((e) => !installedIds.has(e.id) && offerable(e, builtin))
    return {
      write: !sameFiles(outgoing, remote.files),
      outgoing,
      apply,
      invalid,
      state: (version) => ({
        target: state.target,
        version,
        lastSync: this.now().toISOString(),
        conflicts,
        offers,
        installedAtSync: extensions.filter((e) => installedIds.has(e.id)).map((e) => e.id),
        skipped: [...new Set([...local.skipped, ...remote.skipped])].sort(),
        heldBack: [...heldKeys].map((key) => keyPath(key).join('.')).sort(),
      }),
    }
  }

  async resolve(id: string): Promise<SyncStatus> {
    const method = this.deps.method()
    if (!method) return OFF
    const state = this.loadState(method.id)
    const conflict = state.conflicts.find((c) => c.id === id)
    if (!conflict) return this.status()
    const other = conflict.winner === 'local' ? conflict.remote : conflict.local
    const time = this.now().getTime()
    if (conflict.kind === 'setting') {
      const local = this.readLocal()
      if (local.settingsInvalid) return this.status()
      const next = withValueAt(
        local.settings ?? {},
        keyPath(id.slice('setting:'.length)),
        other?.value,
      )
      const path = this.path(SETTINGS_FILE)
      writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
      stamp(path, time)
    } else {
      const path = join(this.deps.configDir, id.slice('file:'.length))
      if (other === null) removeRegularFile(path)
      else {
        writeAtomic(path, String(other.value))
        stamp(path, time)
      }
    }
    this.saveState({ ...state, conflicts: state.conflicts.filter((c) => c.id !== id) })
    return (await this.run()).status
  }

  async install(id: string): Promise<SyncStatus> {
    const method = this.deps.method()
    if (!method) return OFF
    const offer = this.loadState(method.id).offers.find((o) => o.id === id)
    if (!offer) return this.status()
    await this.deps.installExtension(offer.id, offer.marketplace)
    return (await this.run()).status
  }
}
