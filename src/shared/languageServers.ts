import { EDITOR_LANGUAGE_ID_PATTERN } from './editorLanguages'
import type { ExtensionSettingValues } from './extensions'
import { isDangerousSegment } from './protoGuard'

export const LANGUAGE_SERVER_CAPABILITY = 'language-server'
export const LANGUAGE_SERVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const LANGUAGE_SERVER_PROGRAM_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/
export const LANGUAGE_SERVER_SCRIPT_PATTERN = /\.(c|m)?js$/
export const LANGUAGE_SERVER_MARKER_PATTERN = /^[^/\\]{1,100}$/
export const LANGUAGE_SERVER_SUFFIX_PATTERN = /^\.[A-Za-z0-9._+-]{1,40}$/
export const LANGUAGE_SERVER_DOCUMENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9+#._-]{0,39}$/
export const LANGUAGE_SERVER_SETTING_PATH_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_-]{0,39}(\.[A-Za-z_][A-Za-z0-9_-]{0,39}){0,7}$/
export const MAX_LANGUAGE_SERVERS = 8
export const MAX_SERVER_LANGUAGES = 16
export const MAX_SERVER_ARGS = 32
export const SERVER_ARG_MAX = 200
export const SERVER_NAME_MAX = 200
export const MAX_ROOT_MARKERS = 16
export const MAX_DOCUMENT_LANGUAGE_IDS = 32
export const SERVER_JSON_MAX_BYTES = 16 * 1024
export const EXTENSION_DIR_PLACEHOLDER = '{extensionDir}'
export const ROOT_PLACEHOLDER = '{root}'

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

export interface JsonObject {
  [key: string]: JsonValue
}

export interface LanguageServerNodeRun {
  node: string
  args: string[]
}

export interface LanguageServerProgramRun {
  program: string
  package?: string
  args: string[]
}

export type LanguageServerRun = LanguageServerNodeRun | LanguageServerProgramRun

export interface LanguageServerContribution {
  id: string
  name: string
  languages: string[]
  documentLanguageIds?: Record<string, string>
  run: LanguageServerRun
  rootMarkers: string[]
  initializationOptions?: JsonObject
  settings?: JsonObject
  settingPaths?: Record<string, string>
}

export interface LanguageServerSummary {
  id: string
  name: string
  languages: string[]
  command: string
}

export type LanguageServerKind = 'bundled' | 'program'

export type LanguageServerStatus =
  | 'running'
  | 'idle'
  | 'off'
  | 'program-missing'
  | 'sandbox-unavailable'
  | 'crashed'
  | 'pending-approval'

export type LanguageServerSandboxProblem =
  | 'program-unreadable'
  | 'folder-unreadable'
  | 'wrap-failed'

export interface LanguageServerInfo {
  key: string
  extId: string
  extName: string
  serverId: string
  name: string
  languages: string[]
  kind: LanguageServerKind
  command: string
  enabled: boolean
  status: LanguageServerStatus
  folders: number
  program?: string
  requirement?: string
  sandboxProblem?: LanguageServerSandboxProblem
  sandboxDetail?: string
}

export interface LspSessionInfo {
  sessionId: string
  serverKey: string
  root: string
  languageId: string
  initializationOptions: JsonObject
}

export type LspLogEntry =
  | { at: number; kind: 'start'; pid: number; sandboxed: boolean }
  | { at: number; kind: 'initialized'; name: string; version: string }
  | { at: number; kind: 'exit'; code: number | null; signal: string | null }
  | { at: number; kind: 'restart'; attempt: number; limit: number; delayMs: number }
  | { at: number; kind: 'crashed' }
  | { at: number; kind: 'stop'; reason: LspStopReason }
  | { at: number; kind: 'spawn-failed'; text: string }
  | { at: number; kind: 'stderr'; text: string }

export type LspStopReason = 'idle' | 'restart' | 'off' | 'quit' | 'window'

export interface LspLog {
  entries: LspLogEntry[]
  errors: Record<string, number>
}

export const LSP_LOG_MAX_ENTRIES = 400
export const LSP_LOG_LINE_MAX = 500

export interface LspApi {
  servers: () => Promise<LanguageServerInfo[]>
  onServersChanged: (cb: (list: LanguageServerInfo[]) => void) => () => void
  open: (paneId: string, filePath: string) => Promise<LspSessionInfo[]>
  send: (sessionId: string, message: unknown) => void
  release: (sessionId: string) => void
  onMessage: (sessionId: string, cb: (message: unknown) => void) => () => void
  onExit: (sessionId: string, cb: () => void) => () => void
  setEnabled: (serverKey: string, enabled: boolean) => Promise<LanguageServerInfo[]>
  restart: (serverKey: string) => Promise<void>
  log: (serverKey: string) => Promise<LspLog>
}

export function languageServerKey(extId: string, serverId: string): string {
  return `${extId}/${serverId}`
}

export function splitLanguageServerKey(key: unknown): { extId: string; serverId: string } | null {
  if (typeof key !== 'string') return null
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1 || key.indexOf('/', slash + 1) >= 0) return null
  return { extId: key.slice(0, slash), serverId: key.slice(slash + 1) }
}

export function languageServerFeature(key: string): string {
  return `lsp:${key}`
}

export function isProgramRun(run: LanguageServerRun): run is LanguageServerProgramRun {
  return 'program' in run
}

export function languageServerCommand(run: LanguageServerRun): string {
  return [isProgramRun(run) ? run.program : run.node, ...run.args].join(' ')
}

export function languageServerSummary(server: LanguageServerContribution): LanguageServerSummary {
  return {
    id: server.id,
    name: server.name,
    languages: server.languages,
    command: languageServerCommand(server.run),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    return value.map((item) => cleanJson(item)).filter((item) => item !== undefined) as JsonValue[]
  }
  if (!isRecord(value)) return undefined
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (isDangerousSegment(key)) continue
    const cleaned = cleanJson(item)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

function jsonObject(raw: unknown, where: string): JsonObject | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return `${where} must be an object`
  if (new TextEncoder().encode(JSON.stringify(raw)).length > SERVER_JSON_MAX_BYTES) {
    return `${where} is larger than ${SERVER_JSON_MAX_BYTES} bytes`
  }
  return cleanJson(raw) as JsonObject
}

function parseArgs(raw: unknown, where: string): string[] | string {
  if (raw === undefined) return []
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_SERVER_ARGS ||
    !raw.every((arg) => typeof arg === 'string' && arg.length <= SERVER_ARG_MAX)
  ) {
    return `${where}.args must be at most ${MAX_SERVER_ARGS} strings of at most ${SERVER_ARG_MAX} characters`
  }
  return [...(raw as string[])]
}

function parseRun(
  raw: unknown,
  where: string,
  isInside: (path: string) => boolean,
): LanguageServerRun | string {
  if (!isRecord(raw)) return `${where} must be an object`
  const hasNode = raw.node !== undefined
  const hasProgram = raw.program !== undefined
  if (hasNode === hasProgram) return `${where} needs exactly one of node or program`
  const allowed = hasNode ? ['node', 'args'] : ['program', 'package', 'args']
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key))
  if (unknown !== undefined) return `${where}.${unknown} is not allowed here`
  const args = parseArgs(raw.args, where)
  if (typeof args === 'string') return args
  if (hasNode) {
    const node = raw.node
    if (typeof node !== 'string' || !LANGUAGE_SERVER_SCRIPT_PATTERN.test(node) || !isInside(node)) {
      return `${where}.node must be a .js, .mjs or .cjs file inside the extension`
    }
    return { node, args }
  }
  const program = raw.program
  if (typeof program !== 'string' || !LANGUAGE_SERVER_PROGRAM_PATTERN.test(program)) {
    return `${where}.program must be a program name without a path`
  }
  if (raw.package === undefined) return { program, args }
  if (typeof raw.package !== 'string' || !LANGUAGE_SERVER_PROGRAM_PATTERN.test(raw.package)) {
    return `${where}.package must be a package name`
  }
  return { program, package: raw.package, args }
}

function parseLanguages(raw: unknown, where: string): string[] | string {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_SERVER_LANGUAGES ||
    !raw.every((id) => typeof id === 'string' && EDITOR_LANGUAGE_ID_PATTERN.test(id))
  ) {
    return `${where}.languages must be 1-${MAX_SERVER_LANGUAGES} editor language ids`
  }
  return [...new Set(raw as string[])]
}

function parseDocumentLanguageIds(
  raw: unknown,
  where: string,
): Record<string, string> | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return `${where}.documentLanguageIds must be an object`
  const entries = Object.entries(raw)
  if (entries.length > MAX_DOCUMENT_LANGUAGE_IDS) {
    return `${where}.documentLanguageIds has more than ${MAX_DOCUMENT_LANGUAGE_IDS} keys`
  }
  const out: Record<string, string> = {}
  for (const [key, value] of entries) {
    const validKey = key.startsWith('.')
      ? LANGUAGE_SERVER_SUFFIX_PATTERN.test(key)
      : EDITOR_LANGUAGE_ID_PATTERN.test(key)
    if (!validKey) {
      return `${where}.documentLanguageIds.${key} must be an editor language id or a file suffix`
    }
    if (typeof value !== 'string' || !LANGUAGE_SERVER_DOCUMENT_ID_PATTERN.test(value)) {
      return `${where}.documentLanguageIds.${key} must be a language id`
    }
    out[key] = value
  }
  return out
}

function parseRootMarkers(raw: unknown, where: string): string[] | string {
  if (raw === undefined) return []
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_ROOT_MARKERS ||
    !raw.every(
      (marker) =>
        typeof marker === 'string' &&
        LANGUAGE_SERVER_MARKER_PATTERN.test(marker) &&
        marker !== '.' &&
        marker !== '..',
    )
  ) {
    return `${where}.rootMarkers must be at most ${MAX_ROOT_MARKERS} file names`
  }
  return [...new Set(raw as string[])]
}

function parseSettingPaths(
  raw: unknown,
  where: string,
  settingKeys: readonly string[],
): Record<string, string> | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return `${where}.settingPaths must be an object`
  const out: Record<string, string> = {}
  for (const [key, path] of Object.entries(raw)) {
    if (!settingKeys.includes(key)) {
      return `${where}.settingPaths.${key} is not one of the extension's settings`
    }
    if (
      typeof path !== 'string' ||
      !LANGUAGE_SERVER_SETTING_PATH_PATTERN.test(path) ||
      path.split('.').some(isDangerousSegment)
    ) {
      return `${where}.settingPaths.${key} must be a dotted path`
    }
    out[key] = path
  }
  return out
}

function parseServer(
  raw: unknown,
  index: number,
  isInside: (path: string) => boolean,
  settingKeys: readonly string[],
): LanguageServerContribution | string {
  const where = `contributes.languageServers[${index}]`
  if (!isRecord(raw)) return `${where}: must be an object`
  const id = raw.id
  if (typeof id !== 'string' || !LANGUAGE_SERVER_ID_PATTERN.test(id)) return `${where}: invalid id`
  const name = raw.name
  if (typeof name !== 'string' || !name.trim() || name.length > SERVER_NAME_MAX) {
    return `${where}: name must be 1-${SERVER_NAME_MAX} characters`
  }
  const languages = parseLanguages(raw.languages, where)
  if (typeof languages === 'string') return languages
  const documentLanguageIds = parseDocumentLanguageIds(raw.documentLanguageIds, where)
  if (typeof documentLanguageIds === 'string') return documentLanguageIds
  const run = parseRun(raw.run, `${where}.run`, isInside)
  if (typeof run === 'string') return run
  const rootMarkers = parseRootMarkers(raw.rootMarkers, where)
  if (typeof rootMarkers === 'string') return rootMarkers
  const initializationOptions = jsonObject(
    raw.initializationOptions,
    `${where}.initializationOptions`,
  )
  if (typeof initializationOptions === 'string') return initializationOptions
  const settings = jsonObject(raw.settings, `${where}.settings`)
  if (typeof settings === 'string') return settings
  const settingPaths = parseSettingPaths(raw.settingPaths, where, settingKeys)
  if (typeof settingPaths === 'string') return settingPaths
  return {
    id,
    name,
    languages,
    ...(documentLanguageIds ? { documentLanguageIds } : {}),
    run,
    rootMarkers,
    ...(initializationOptions ? { initializationOptions } : {}),
    ...(settings ? { settings } : {}),
    ...(settingPaths ? { settingPaths } : {}),
  }
}

export function parseLanguageServers(
  raw: unknown,
  options: {
    isInside: (path: string) => boolean
    capabilities: readonly string[]
    settingKeys: readonly string[]
  },
): LanguageServerContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_LANGUAGE_SERVERS) {
    return `contributes.languageServers must be an array of at most ${MAX_LANGUAGE_SERVERS}`
  }
  if (raw.length > 0 && !options.capabilities.includes(LANGUAGE_SERVER_CAPABILITY)) {
    return `contributes.languageServers needs the '${LANGUAGE_SERVER_CAPABILITY}' capability`
  }
  const servers: LanguageServerContribution[] = []
  for (const [index, item] of raw.entries()) {
    const server = parseServer(item, index, options.isInside, options.settingKeys)
    if (typeof server === 'string') return server
    if (servers.some((s) => s.id === server.id)) {
      return `contributes.languageServers[${index}]: duplicate id '${server.id}'`
    }
    servers.push(server)
  }
  return servers
}

export function substitutePlaceholders(text: string, extensionDir: string, root: string): string {
  return text.replaceAll(EXTENSION_DIR_PLACEHOLDER, extensionDir).replaceAll(ROOT_PLACEHOLDER, root)
}

export function substituteJson(value: JsonValue, extensionDir: string, root: string): JsonValue {
  if (typeof value === 'string') return substitutePlaceholders(value, extensionDir, root)
  if (Array.isArray(value)) return value.map((item) => substituteJson(item, extensionDir, root))
  if (value === null || typeof value !== 'object') return value
  const out: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = substituteJson(item, extensionDir, root)
  }
  return out
}

export function overlaySettings(
  base: JsonObject,
  paths: Record<string, string>,
  values: ExtensionSettingValues,
): JsonObject {
  const out = structuredClone(base)
  for (const [key, path] of Object.entries(paths)) {
    if (!Object.hasOwn(values, key)) continue
    const segments = path.split('.')
    let node = out
    for (const segment of segments.slice(0, -1)) {
      const next = Object.hasOwn(node, segment) ? node[segment] : undefined
      if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
        node = next
      } else {
        const created: JsonObject = {}
        node[segment] = created
        node = created
      }
    }
    node[segments[segments.length - 1]] = values[key]
  }
  return out
}

export function configurationSection(settings: JsonObject, section: unknown): JsonValue {
  if (typeof section !== 'string' || section === '') return settings
  let node: JsonValue = settings
  for (const segment of section.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return null
    if (!Object.hasOwn(node, segment)) return null
    node = node[segment]
  }
  return node
}

export function documentLanguageId(
  server: Pick<LanguageServerContribution, 'documentLanguageIds'>,
  path: string,
  language: string,
): string {
  const ids = server.documentLanguageIds
  if (!ids) return language
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  let best: string | undefined
  for (const key of Object.keys(ids)) {
    if (!key.startsWith('.') || !name.endsWith(key.toLowerCase())) continue
    if (best === undefined || key.length > best.length) best = key
  }
  if (best !== undefined) return ids[best]
  return Object.hasOwn(ids, language) ? ids[language] : language
}
