import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { SecretSpan } from '../../shared/privacy/redaction'
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
  type Profile,
  removeRegularFile,
  SECRETS_FILE,
  SETTINGS_FILE,
  syncedSettings,
  withLocalOnly,
} from './profile'
import type { SecretPlan, SecretSync } from './secrets'
import { type LocalProfile, type SyncState, type SyncStore, stamp } from './syncStore'

export interface Plan {
  write: boolean
  outgoing: Map<string, string>
  apply: () => boolean
  saveSecretBase: () => void
  state: (version: string) => SyncState
  invalid: string[]
}

export class ScanFailed extends Error {}

export interface SyncPlanDeps {
  configDir: string
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
  const { remote, local, theirs, base, remoteTime } = inputs
  const stopped = local.settingsInvalid || theirs.settingsInvalid
  if (stopped) invalid.push(SETTINGS_FILE)
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

function outgoingProfile(
  inputs: PlanInputs,
  settings: SettingsOutcome,
  files: FilesOutcome,
): Map<string, string> {
  const { remote, local, theirs, remoteTime, secretPlan } = inputs
  const times: Record<string, number> = {}
  const settingsSame = sameJson(settings.outgoing ?? {}, syncedSettings(theirs.settings ?? {}))
  times[SETTINGS_FILE] = settingsSame
    ? remoteTime(SETTINGS_FILE)
    : Math.max(local.settingsTime, remoteTime(SETTINGS_FILE))
  for (const [path, text] of files.outgoing) {
    times[path] = theirs.files.get(path) === text ? remoteTime(path) : (local.times.get(path) ?? 0)
  }
  const outgoing = encodeProfile({
    settings: settings.outgoing,
    files: files.outgoing,
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
  const local = store.readLocal()
  const theirs = decodeProfile(remote.files)
  const baseFiles = store.loadBase(state.target)
  const base: Profile | null = baseFiles ? decodeProfile(baseFiles) : null
  const invalid: string[] = []
  const remoteTime = (path: string): number => theirs.times[path] ?? 0
  const inputs: PlanInputs = {
    remote,
    state,
    local,
    theirs,
    base,
    remoteTime,
    secretPlan,
  }

  const settings = await mergeSettings(deps, inputs, invalid)
  const files = mergeFiles(inputs)
  const outgoing = outgoingProfile(inputs, settings, files)
  const apply = planApply(deps, store, inputs, settings, files)

  return {
    write: !sameFiles(outgoing, remote.files),
    outgoing,
    apply,
    saveSecretBase: () => secretPlan?.saveBase(),
    invalid,
    state: (version) => ({
      target: state.target,
      version,
      lastSync: now().toISOString(),
      skipped: [...new Set([...local.skipped, ...remote.skipped])].sort(),
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
