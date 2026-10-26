import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { SecretSpan } from '../../shared/privacy/redaction'
import type { SyncKinds } from '../../shared/profileSync/syncKinds'
import {
  canonicalJson,
  flatten,
  keyPath,
  type Merged,
  mergeMaps,
  sameJson,
  unflatten,
} from './merge'
import {
  decodeProfile,
  encodeProfile,
  type JsonObject,
  kindOfPath,
  offerable,
  type Profile,
  removeRegularFile,
  SECRETS_FILE,
  SETTINGS_FILE,
  type SyncedExtension,
  syncedSettings,
  withLocalOnly,
} from './profile'
import type { SecretPlan, SecretSync } from './secrets'
import { type LocalProfile, type SyncState, type SyncStore, stamp } from './syncStore'

export interface Plan {
  write: boolean
  outgoing: Map<string, string>
  baseline: Map<string, string>
  apply: () => boolean
  saveSecretBase: () => void
  state: (version: string) => SyncState
  invalid: string[]
}

export class ScanFailed extends Error {}

export interface SyncPlanDeps {
  configDir: string
  kinds: () => SyncKinds
  installedExtensions: () => SyncedExtension[]
  builtinIds: () => string[]
  detectSecrets: (text: string) => Promise<SecretSpan[]>
  secrets?: SecretSync
}

interface PlanRemote {
  files: Map<string, string>
  skipped: string[]
}

interface PlanInputs {
  remote: PlanRemote
  state: SyncState
  local: LocalProfile
  theirs: Profile
  base: Profile | null
  kinds: SyncKinds
  builtin: string[]
  untouched: ReadonlyMap<string, string>
  remoteTime: (path: string) => number
  secretPlan: SecretPlan | null
}

interface SettingsOutcome {
  stopped: boolean
  merge: Merged<unknown>
  heldKeys: Set<string>
  outgoing: JsonObject | null
}

interface FilesOutcome {
  merge: Merged<string>
  outgoing: Map<string, string>
}

interface ExtensionsOutcome {
  extensions: SyncedExtension[]
  installedIds: Set<string>
}

function scopeOf(kinds: SyncKinds) {
  const has = (path: string): boolean => {
    const kind = kindOfPath(path)
    return kind === null || kinds[kind]
  }
  return {
    has,
    only: <V>(map: ReadonlyMap<string, V>): Map<string, V> =>
      new Map([...map].filter(([path]) => has(path))),
    rest: <V>(map: ReadonlyMap<string, V>): Map<string, V> =>
      new Map([...map].filter(([path]) => !has(path))),
  }
}

const sameFiles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([path, text]) => b.get(path) === text)

async function heldBackKeys(
  deps: SyncPlanDeps,
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
    spans = await deps.detectSecrets(text)
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

async function mergeSettings(
  deps: SyncPlanDeps,
  inputs: PlanInputs,
  invalid: string[],
): Promise<SettingsOutcome> {
  const { remote, local, theirs, base, remoteTime, kinds } = inputs
  const unreadable = local.settingsInvalid || theirs.settingsInvalid
  if (unreadable && kinds.settings) invalid.push(SETTINGS_FILE)
  const stopped = unreadable || !kinds.settings
  const localSettings = flatten(syncedSettings(local.settings ?? {}))
  const remoteSettings = flatten(syncedSettings(theirs.settings ?? {}))
  const baseSettings = base ? flatten(syncedSettings(base.settings ?? {})) : null
  const settingsWinner = (): 'local' | 'remote' =>
    local.settingsTime > remoteTime(SETTINGS_FILE) ? 'local' : 'remote'
  const merge = stopped
    ? { merged: remoteSettings, conflicts: [] }
    : mergeMaps(baseSettings, localSettings, remoteSettings, sameJson, settingsWinner)
  const heldKeys = stopped
    ? new Set<string>()
    : await heldBackKeys(deps, merge.merged, remoteSettings)
  const outgoingLeaves = new Map(merge.merged)
  for (const key of heldKeys) {
    if (remoteSettings.has(key)) outgoingLeaves.set(key, remoteSettings.get(key))
    else outgoingLeaves.delete(key)
  }
  const outgoing =
    outgoingLeaves.size > 0 || remote.files.has(SETTINGS_FILE) || local.settings
      ? unflatten(outgoingLeaves)
      : null
  return { stopped, merge, heldKeys, outgoing }
}

function mergeFiles(inputs: PlanInputs): FilesOutcome {
  const { remote, local, theirs, base, remoteTime } = inputs
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
  const merge = mergeMaps(
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
  const outgoing = new Map(merge.merged)
  for (const path of remote.skipped) outgoing.delete(path)
  return { merge, outgoing }
}

function mergeExtensions(deps: SyncPlanDeps, inputs: PlanInputs): ExtensionsOutcome {
  const { state, theirs, base, builtin, kinds } = inputs
  const installed = deps.installedExtensions().filter((e) => !builtin.includes(e.id))
  const installedIds = new Set(installed.map((e) => e.id))
  if (!kinds.extensions) return { extensions: theirs.extensions, installedIds }
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
  return { extensions, installedIds }
}

function outgoingProfile(
  inputs: PlanInputs,
  settings: SettingsOutcome,
  files: FilesOutcome,
  extensions: SyncedExtension[],
): Map<string, string> {
  const { remote, local, theirs, remoteTime, secretPlan, untouched } = inputs
  const times: Record<string, number> = {}
  const settingsSame = sameJson(settings.outgoing ?? {}, syncedSettings(theirs.settings ?? {}))
  times[SETTINGS_FILE] = settingsSame
    ? remoteTime(SETTINGS_FILE)
    : Math.max(local.settingsTime, remoteTime(SETTINGS_FILE))
  for (const [path, text] of files.outgoing) {
    times[path] = theirs.files.get(path) === text ? remoteTime(path) : (local.times.get(path) ?? 0)
  }
  for (const path of untouched.keys()) times[path] = remoteTime(path)
  const outgoing = encodeProfile({
    settings: settings.outgoing,
    extensions,
    files: new Map([...files.outgoing, ...untouched]),
    times,
  })
  if (settings.stopped) {
    const raw = remote.files.get(SETTINGS_FILE)
    if (raw === undefined) outgoing.delete(SETTINGS_FILE)
    else outgoing.set(SETTINGS_FILE, raw)
  }
  const secretsOut = secretPlan ? secretPlan.outgoing : undefined
  const remoteSecrets = remote.files.get(SECRETS_FILE)
  if (secretsOut === undefined) {
    if (remoteSecrets !== undefined) outgoing.set(SECRETS_FILE, remoteSecrets)
  } else if (secretsOut !== null) outgoing.set(SECRETS_FILE, secretsOut)
  return outgoing
}

function planApply(
  deps: SyncPlanDeps,
  store: SyncStore,
  inputs: PlanInputs,
  settings: SettingsOutcome,
  files: FilesOutcome,
): () => boolean {
  const { local, remoteTime, secretPlan } = inputs
  const mergedSettingsLeaves = settings.merge.merged
  const mergedFiles = files.merge.merged
  return (): boolean => {
    let pulledSettings = false
    if (!settings.stopped) {
      const next = withLocalOnly(unflatten(mergedSettingsLeaves), local.settings ?? {})
      const changed = local.settings
        ? canonicalJson(next) !== canonicalJson(local.settings)
        : Object.keys(next).length > 0
      if (changed) {
        const path = store.path(SETTINGS_FILE)
        writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
        stamp(path, Math.max(local.settingsTime, remoteTime(SETTINGS_FILE)))
        pulledSettings = true
      }
    }
    const paths = new Set([...local.files.keys(), ...mergedFiles.keys()])
    for (const path of paths) {
      if (local.skipped.includes(path)) continue
      const want = mergedFiles.get(path)
      if (want === local.files.get(path)) continue
      const target = join(deps.configDir, path)
      if (want === undefined) removeRegularFile(target)
      else {
        writeFileAtomic(target, want)
        stamp(target, remoteTime(path))
      }
    }
    secretPlan?.apply()
    return pulledSettings
  }
}

async function plan(
  deps: SyncPlanDeps,
  store: SyncStore,
  now: () => Date,
  remote: PlanRemote,
  state: SyncState,
): Promise<Plan> {
  const secretPlan = deps.secrets ? await deps.secrets.plan(remote.files.get(SECRETS_FILE)) : null
  const kinds = deps.kinds()
  const scope = scopeOf(kinds)
  const decoded = decodeProfile(remote.files)
  const theirs: Profile = { ...decoded, files: scope.only(decoded.files) }
  const untouched = scope.rest(decoded.files)
  const stored = store.readLocal()
  const local: LocalProfile = {
    ...stored,
    files: scope.only(stored.files),
    times: scope.only(stored.times),
    skipped: stored.skipped.filter(scope.has),
  }
  const baseFiles = store.loadBase(state.target)
  const decodedBase = baseFiles ? decodeProfile(baseFiles) : null
  const base: Profile | null = decodedBase
    ? { ...decodedBase, files: scope.only(decodedBase.files) }
    : null
  const scoped: PlanRemote = { files: remote.files, skipped: remote.skipped.filter(scope.has) }
  const builtin = deps.builtinIds()
  const invalid: string[] = []
  const remoteTime = (path: string): number => theirs.times[path] ?? 0
  const inputs: PlanInputs = {
    remote: scoped,
    state,
    local,
    theirs,
    base,
    kinds,
    builtin,
    untouched,
    remoteTime,
    secretPlan,
  }

  const settings = await mergeSettings(deps, inputs, invalid)
  const files = mergeFiles(inputs)
  const { extensions, installedIds } = mergeExtensions(deps, inputs)
  const outgoing = outgoingProfile(inputs, settings, files, extensions)
  const apply = planApply(deps, store, inputs, settings, files)

  const offers = kinds.extensions
    ? extensions.filter((e) => !installedIds.has(e.id) && offerable(e, builtin))
    : []
  return {
    write: !sameFiles(outgoing, remote.files),
    outgoing,
    baseline: scope.only(outgoing),
    apply,
    saveSecretBase: () => secretPlan?.saveBase(),
    invalid,
    state: (version) => ({
      target: state.target,
      version,
      lastSync: now().toISOString(),
      offers,
      installedAtSync: extensions.filter((e) => installedIds.has(e.id)).map((e) => e.id),
      skipped: [...new Set([...local.skipped, ...scoped.skipped])].sort(),
      heldBack: [...settings.heldKeys].map((key) => keyPath(key).join('.')).sort(),
      secrets: secretPlan?.status ?? null,
    }),
  }
}

export function createSyncPlanner(deps: SyncPlanDeps, store: SyncStore, now: () => Date) {
  return {
    plan: (remote: PlanRemote, state: SyncState): Promise<Plan> =>
      plan(deps, store, now, remote, state),
  }
}
