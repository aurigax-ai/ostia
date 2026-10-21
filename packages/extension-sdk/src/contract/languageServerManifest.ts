import { EDITOR_LANGUAGE_ID_PATTERN } from './editorLanguages'
import { isRecord } from './isRecord'
import {
  DOWNLOAD_URL_MAX,
  GO_MODULE_MAX,
  hasControlCharacter,
  type JsonObject,
  type JsonValue,
  LANGUAGE_SERVER_ARCHIVES,
  LANGUAGE_SERVER_CAPABILITY,
  LANGUAGE_SERVER_DOCUMENT_ID_PATTERN,
  LANGUAGE_SERVER_DOWNLOAD_HOSTS,
  LANGUAGE_SERVER_EXECUTABLE_PATTERN,
  LANGUAGE_SERVER_GO_MODULE_PATTERN,
  LANGUAGE_SERVER_GO_VERSION_PATTERN,
  LANGUAGE_SERVER_ID_PATTERN,
  LANGUAGE_SERVER_MARKER_PATTERN,
  LANGUAGE_SERVER_PLATFORMS,
  LANGUAGE_SERVER_PROGRAM_PATTERN,
  LANGUAGE_SERVER_SCRIPT_PATTERN,
  LANGUAGE_SERVER_SETTING_PATH_PATTERN,
  LANGUAGE_SERVER_SHA256_PATTERN,
  LANGUAGE_SERVER_SUFFIX_PATTERN,
  LANGUAGE_SERVER_VERSION_PATTERN,
  type LanguageServerArchive,
  type LanguageServerAsset,
  type LanguageServerContribution,
  type LanguageServerDownload,
  type LanguageServerGoInstall,
  type LanguageServerPlatform,
  type LanguageServerRun,
  MAX_DOCUMENT_LANGUAGE_IDS,
  MAX_LANGUAGE_SERVERS,
  MAX_ROOT_MARKERS,
  MAX_SERVER_ARGS,
  MAX_SERVER_LANGUAGES,
  SERVER_ARG_MAX,
  SERVER_JSON_MAX_BYTES,
  SERVER_NAME_MAX,
} from './languageServers'
import { isDangerousSegment } from './protoGuard'

export function downloadUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > DOWNLOAD_URL_MAX) return 'must be an https URL'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'must be an https URL'
  }
  if (url.protocol !== 'https:') return 'must be an https URL'
  if (url.username || url.password || url.port) return 'must not carry credentials or a port'
  if (!LANGUAGE_SERVER_DOWNLOAD_HOSTS.includes(url.hostname)) {
    return `host must be one of ${LANGUAGE_SERVER_DOWNLOAD_HOSTS.join(', ')}`
  }
  return url.href === raw ? null : 'must be a plain, already encoded URL'
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

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(raw).find((key) => !allowed.includes(key)) ?? null
}

function parseAsset(raw: unknown, where: string): LanguageServerAsset | string {
  if (!isRecord(raw)) return `${where} must be an object`
  const extra = onlyKeys(raw, ['url', 'sha256', 'archive', 'executable'])
  if (extra !== null) return `${where}.${extra} is not allowed here`
  const urlProblem = downloadUrlProblem(raw.url)
  if (urlProblem) return `${where}.url ${urlProblem}`
  if (typeof raw.sha256 !== 'string' || !LANGUAGE_SERVER_SHA256_PATTERN.test(raw.sha256)) {
    return `${where}.sha256 must be 64 lowercase hex characters`
  }
  const archive = raw.archive
  if (!LANGUAGE_SERVER_ARCHIVES.includes(archive as LanguageServerArchive)) {
    return `${where}.archive must be one of ${LANGUAGE_SERVER_ARCHIVES.join(', ')}`
  }
  const executable = raw.executable
  if (
    typeof executable !== 'string' ||
    !LANGUAGE_SERVER_EXECUTABLE_PATTERN.test(executable) ||
    executable.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    return `${where}.executable must be a relative path inside the download`
  }
  if ((archive === 'plain' || archive === 'gz') && executable.includes('/')) {
    return `${where}.executable must be a file name for a ${archive} download`
  }
  return {
    url: raw.url as string,
    sha256: raw.sha256,
    archive: archive as LanguageServerArchive,
    executable,
  }
}

function parseDownload(raw: unknown, where: string): LanguageServerDownload | string {
  if (!isRecord(raw)) return `${where} must be an object`
  const extra = onlyKeys(raw, ['program', 'version', 'assets'])
  if (extra !== null) return `${where}.${extra} is not allowed here`
  if (typeof raw.program !== 'string' || !LANGUAGE_SERVER_PROGRAM_PATTERN.test(raw.program)) {
    return `${where}.program must be a program name without a path`
  }
  const version = raw.version
  if (typeof version !== 'string' || !LANGUAGE_SERVER_VERSION_PATTERN.test(version)) {
    return `${where}.version must be a pinned version`
  }
  if (!isRecord(raw.assets) || Object.keys(raw.assets).length === 0) {
    return `${where}.assets must name at least one platform`
  }
  const assets: LanguageServerDownload['assets'] = {}
  for (const [platform, value] of Object.entries(raw.assets)) {
    if (!LANGUAGE_SERVER_PLATFORMS.includes(platform as LanguageServerPlatform)) {
      return `${where}.assets.${platform} must be one of ${LANGUAGE_SERVER_PLATFORMS.join(', ')}`
    }
    const asset = parseAsset(value, `${where}.assets.${platform}`)
    if (typeof asset === 'string') return asset
    assets[platform as LanguageServerPlatform] = asset
  }
  return { program: raw.program, version, assets }
}

function parseGoInstall(raw: unknown, where: string): LanguageServerGoInstall | string {
  if (!isRecord(raw)) return `${where} must be an object`
  const extra = onlyKeys(raw, ['module', 'version', 'binary'])
  if (extra !== null) return `${where}.${extra} is not allowed here`
  const { module, version, binary } = raw
  if (
    typeof module !== 'string' ||
    module.length > GO_MODULE_MAX ||
    !LANGUAGE_SERVER_GO_MODULE_PATTERN.test(module)
  ) {
    return `${where}.module must be a Go module path such as golang.org/x/tools/gopls`
  }
  if (typeof version !== 'string' || !LANGUAGE_SERVER_GO_VERSION_PATTERN.test(version)) {
    return `${where}.version must be a pinned version such as v0.20.0`
  }
  if (typeof binary !== 'string' || !LANGUAGE_SERVER_PROGRAM_PATTERN.test(binary)) {
    return `${where}.binary must be a program name without a path`
  }
  return { module, version, binary }
}

function parseRun(
  raw: unknown,
  where: string,
  isInside: (path: string) => boolean,
): LanguageServerRun | string {
  if (!isRecord(raw)) return `${where} must be an object`
  const forms = (['node', 'program', 'download', 'goInstall'] as const).filter(
    (form) => raw[form] !== undefined,
  )
  if (forms.length !== 1) {
    return `${where} needs exactly one of node, program, download or goInstall`
  }
  const [form] = forms
  const hasNode = form === 'node'
  const allowed = form === 'program' ? ['program', 'package', 'args'] : [form, 'args']
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key))
  if (unknown !== undefined) return `${where}.${unknown} is not allowed here`
  const args = parseArgs(raw.args, where)
  if (typeof args === 'string') return args
  if (form === 'download') {
    const download = parseDownload(raw.download, `${where}.download`)
    return typeof download === 'string' ? download : { download, args }
  }
  if (form === 'goInstall') {
    const goInstall = parseGoInstall(raw.goInstall, `${where}.goInstall`)
    return typeof goInstall === 'string' ? goInstall : { goInstall, args }
  }
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
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > SERVER_NAME_MAX ||
    hasControlCharacter(name)
  ) {
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
