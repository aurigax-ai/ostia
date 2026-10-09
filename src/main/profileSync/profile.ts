import {
  type Stats,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { SPEC_COMMAND_PATTERN, SPEC_FILE_MAX_BYTES } from '../../shared/completionSpec'
import { PROGRAM_SETTINGS } from '../../shared/programSettings'
import { VIEW_FILES_MAX, VIEW_FILE_MAX_BYTES, VIEW_NAME } from '../../shared/views'
import { normalizeMarketplaceUrl } from '../extensions/marketplace'
import { WORKFLOW_FILES_MAX, WORKFLOW_FILE_MAX_BYTES } from '../workspaces/workflows'

export type JsonObject = Record<string, unknown>

export interface SyncedExtension {
  id: string
  marketplace: string
}

export const SETTINGS_FILE = 'settings.json'
const EXTENSIONS_FILE = 'extensions.json'
const META_FILE = 'profile.json'
export const SECRETS_FILE = 'secrets.enc'
export const TOP_FILES = [SETTINGS_FILE, EXTENSIONS_FILE, META_FILE, SECRETS_FILE] as const
export const TOP_FILE_MAX_BYTES = 1024 * 1024
export const SECRETS_FILE_MAX_BYTES = 16 * 1024 * 1024
const COMPLETION_FILES_MAX = 500

export const LOCAL_ONLY_ROOTS: readonly string[] = [
  'sync',
  'capabilities',
  'approvals',
  'trustedActions',
  'sandbox',
]

export interface ProfileFolder {
  name: string
  accepts: (file: string) => boolean
  maxBytes: number
  maxFiles: number
}

const stemOf = (file: string, ext: string): string | null =>
  file.endsWith(ext) ? file.slice(0, -ext.length) : null

export const PROFILE_FOLDERS: readonly ProfileFolder[] = [
  {
    name: 'workflows',
    accepts: (file) => /^[A-Za-z0-9][A-Za-z0-9._ -]*\.ya?ml$/i.test(file),
    maxBytes: WORKFLOW_FILE_MAX_BYTES,
    maxFiles: WORKFLOW_FILES_MAX,
  },
  {
    name: 'completions',
    accepts: (file) => SPEC_COMMAND_PATTERN.test(stemOf(file, '.json') ?? ''),
    maxBytes: SPEC_FILE_MAX_BYTES,
    maxFiles: COMPLETION_FILES_MAX,
  },
  {
    name: 'views',
    accepts: (file) => VIEW_NAME.test(stemOf(file, '.json') ?? ''),
    maxBytes: VIEW_FILE_MAX_BYTES,
    maxFiles: VIEW_FILES_MAX,
  },
]

export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const LOCAL_ONLY_FIELDS: readonly { group: string; field: string }[] = [
  ...PROGRAM_SETTINGS,
  { group: 'privacy', field: 'telemetry' },
]

export function isLocalOnlyPath(path: readonly string[]): boolean {
  if (LOCAL_ONLY_ROOTS.includes(path[0])) return true
  return LOCAL_ONLY_FIELDS.some(({ group, field }) => path[0] === group && path[1] === field)
}

export function syncedSettings(settings: JsonObject): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(settings)) {
    if (LOCAL_ONLY_ROOTS.includes(key)) continue
    if (!isObject(value)) {
      out[key] = value
      continue
    }
    const group: JsonObject = {}
    for (const [field, inner] of Object.entries(value)) {
      if (!isLocalOnlyPath([key, field])) group[field] = inner
    }
    if (Object.keys(group).length > 0 || Object.keys(value).length === 0) out[key] = group
  }
  return out
}

export function withLocalOnly(merged: JsonObject, local: JsonObject): JsonObject {
  const out = structuredClone(merged)
  for (const key of LOCAL_ONLY_ROOTS) if (key in local) out[key] = local[key]
  for (const { group, field } of LOCAL_ONLY_FIELDS) {
    const from = local[group]
    if (!isObject(from) || !(field in from)) continue
    const into = isObject(out[group]) ? (out[group] as JsonObject) : {}
    into[field] = from[field]
    out[group] = into
  }
  return out
}

function parseSyncedExtensions(raw: unknown): SyncedExtension[] {
  const list = isObject(raw) && Array.isArray(raw.extensions) ? raw.extensions : []
  const out: SyncedExtension[] = []
  for (const item of list) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.marketplace !== 'string') {
      continue
    }
    if (out.some((e) => e.id === item.id)) continue
    out.push({ id: item.id, marketplace: item.marketplace })
  }
  return out
}

export function offerable(entry: SyncedExtension, builtinIds: readonly string[]): boolean {
  if (builtinIds.includes(entry.id)) return false
  return normalizeMarketplaceUrl(entry.marketplace) === entry.marketplace
}

export interface Profile {
  settings: JsonObject | null
  settingsInvalid: boolean
  extensions: SyncedExtension[]
  files: Map<string, string>
  times: Record<string, number>
}

const parseJson = (text: string | undefined): { value: unknown; invalid: boolean } => {
  if (text === undefined) return { value: null, invalid: false }
  try {
    return { value: JSON.parse(text) as unknown, invalid: false }
  } catch {
    return { value: null, invalid: true }
  }
}

export function decodeProfile(files: ReadonlyMap<string, string>): Profile {
  const settings = parseJson(files.get(SETTINGS_FILE))
  const settingsInvalid = settings.invalid || (settings.value !== null && !isObject(settings.value))
  const meta = parseJson(files.get(META_FILE)).value
  const times: Record<string, number> = {}
  if (isObject(meta) && isObject(meta.times)) {
    for (const [path, time] of Object.entries(meta.times)) {
      if (typeof time === 'number' && Number.isFinite(time)) times[path] = time
    }
  }
  const profileFiles = new Map<string, string>()
  for (const [path, text] of files) if (folderOf(path)) profileFiles.set(path, text)
  return {
    settings: settingsInvalid ? null : (settings.value as JsonObject | null),
    settingsInvalid,
    extensions: parseSyncedExtensions(parseJson(files.get(EXTENSIONS_FILE)).value),
    files: profileFiles,
    times,
  }
}

export function encodeProfile(profile: {
  settings: JsonObject | null
  extensions: readonly SyncedExtension[]
  files: ReadonlyMap<string, string>
  times: Record<string, number>
}): Map<string, string> {
  const out = new Map<string, string>()
  if (profile.settings) {
    out.set(SETTINGS_FILE, `${JSON.stringify(profile.settings, null, 2)}\n`)
  }
  if (profile.extensions.length > 0) {
    const extensions = [...profile.extensions].sort((a, b) => a.id.localeCompare(b.id))
    out.set(EXTENSIONS_FILE, `${JSON.stringify({ extensions }, null, 2)}\n`)
  }
  for (const [path, text] of [...profile.files].sort(([a], [b]) => a.localeCompare(b))) {
    out.set(path, text)
  }
  const times = Object.fromEntries(
    Object.entries(profile.times)
      .filter(([path]) => out.has(path))
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  out.set(META_FILE, `${JSON.stringify({ times }, null, 2)}\n`)
  return out
}

export function folderOf(path: string): ProfileFolder | null {
  const slash = path.indexOf('/')
  if (slash < 0 || path.indexOf('/', slash + 1) >= 0) return null
  const folder = PROFILE_FOLDERS.find((f) => f.name === path.slice(0, slash))
  return folder?.accepts(path.slice(slash + 1)) ? folder : null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

export interface FolderRead {
  files: Map<string, string>
  times: Map<string, number>
  skipped: string[]
}

export function readProfileFolders(root: string): FolderRead {
  const out: FolderRead = { files: new Map(), times: new Map(), skipped: [] }
  for (const folder of PROFILE_FOLDERS) {
    const dir = join(root, folder.name)
    if (!lstatOrNull(dir)?.isDirectory()) continue
    let names: string[]
    try {
      names = readdirSync(dir).filter(folder.accepts).sort()
    } catch {
      continue
    }
    let taken = 0
    for (const name of names) {
      const rel = `${folder.name}/${name}`
      const file = lstatOrNull(join(dir, name))
      if (!file?.isFile() || file.size > folder.maxBytes || taken >= folder.maxFiles) {
        out.skipped.push(rel)
        continue
      }
      try {
        out.files.set(rel, readFileSync(join(dir, name), 'utf8'))
        out.times.set(rel, file.mtimeMs)
        taken++
      } catch {
        out.skipped.push(rel)
      }
    }
  }
  return out
}

export function readTopFile(
  path: string,
  maxBytes = TOP_FILE_MAX_BYTES,
): { text: string; mtimeMs: number } | 'skipped' | null {
  const st = lstatOrNull(path)
  if (!st) return null
  if (!st.isFile() || st.size > maxBytes) return 'skipped'
  try {
    return { text: readFileSync(path, 'utf8'), mtimeMs: st.mtimeMs }
  } catch {
    return 'skipped'
  }
}

export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export function removeRegularFile(path: string): void {
  if (lstatOrNull(path)?.isFile()) unlinkSync(path)
}
