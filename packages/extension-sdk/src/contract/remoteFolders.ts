export const REMOTE_SCHEME = 'remote://'
export const REMOTE_FOLDER_ID_PATTERN = /^[a-z0-9]{12}$/
export const REMOTE_HOST_PATTERN = /^[A-Za-z0-9._@:-]{1,330}$/
export const REMOTE_HOST_NAME_PATTERN = /^[A-Za-z0-9._-]{1,253}$/
export const REMOTE_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/
export const REMOTE_PATH_MAX = 4096
export const REMOTE_NAME_MAX = 255
export const REMOTE_ENTRIES_MAX = 5000
export const REMOTE_FILE_MAX_BYTES = 2 * 1024 * 1024
export const REMOTE_FOLDERS_PER_WORKSPACE = 8
export const FOLDER_CLOSED_EVENT = 'folder.closed'

export interface RemoteFolder {
  id: string
  workspaceId: string
  extId: string
  extName: string
  host: string
  root: string
}

export interface RemoteFolderAsk {
  extName: string
  host: string
  path: string
}

export interface RemoteCwd {
  host: string
  cwd: string
}

export interface RemoteEntry {
  name: string
  dir: boolean
}

export const REMOTE_FILE_ERRORS = [
  'unknown-folder',
  'invalid-path',
  'not-found',
  'not-file',
  'not-dir',
  'too-large',
  'binary',
  'changed',
  'denied',
  'outside',
  'read-only',
  'unavailable',
  'failed',
] as const

export type RemoteFileError = (typeof REMOTE_FILE_ERRORS)[number]

export interface RemoteFailure {
  ok: false
  error: RemoteFileError
}

export type RemoteListResult =
  | { ok: true; entries: RemoteEntry[]; truncated: boolean }
  | RemoteFailure
export type RemoteStatResult = { ok: true; kind: 'file' | 'dir'; version?: string } | RemoteFailure
export type RemoteReadResult = { ok: true; content: string; version: string } | RemoteFailure
export type RemoteWriteResult = { ok: true; version: string } | RemoteFailure

export type RemoteFilesOp = 'list' | 'stat' | 'read' | 'write'

export const REMOTE_WRITE_ANY = 'any'
export const REMOTE_WRITE_NEW = 'new'

export interface RemoteFilesRequest {
  op: RemoteFilesOp
  folderId: string
  root: string
  path: string
  content?: string
  baseVersion?: string
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function normalizeRemotePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > REMOTE_PATH_MAX) return null
  if (!raw.startsWith('/') || hasControlChar(raw) || raw.includes('�')) return null
  const kept: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    kept.push(segment)
  }
  return `/${kept.join('/')}`
}

export function isInsideRoot(root: string, path: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`)
}

export function remotePath(folderId: string, path: string): string {
  return `${REMOTE_SCHEME}${folderId}${path}`
}

export function isRemotePath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(REMOTE_SCHEME)
}

export function parseRemotePath(raw: unknown): { folderId: string; path: string } | null {
  if (typeof raw !== 'string' || !raw.startsWith(REMOTE_SCHEME)) return null
  const rest = raw.slice(REMOTE_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const folderId = rest.slice(0, slash)
  if (!REMOTE_FOLDER_ID_PATTERN.test(folderId)) return null
  const path = normalizeRemotePath(rest.slice(slash))
  return path === null ? null : { folderId, path }
}

export function remoteChild(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

export function normalizeRemoteCwd(raw: unknown): RemoteCwd | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { host, cwd } = raw as Record<string, unknown>
  if (typeof host !== 'string' || !REMOTE_HOST_NAME_PATTERN.test(host)) return null
  const path = normalizeRemotePath(cwd)
  return path === null ? null : { host, cwd: path }
}

export function isRemoteName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= REMOTE_NAME_MAX &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('�') &&
    !hasControlChar(name)
  )
}

function failureOf(raw: unknown): RemoteFailure {
  const error = (raw as { error?: unknown } | null)?.error
  const known = (REMOTE_FILE_ERRORS as readonly unknown[]).includes(error)
  return { ok: false, error: known ? (error as RemoteFileError) : 'failed' }
}

function succeeded(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true
}

export function normalizeRemoteListing(raw: unknown): RemoteListResult {
  if (!succeeded(raw)) return failureOf(raw)
  if (!Array.isArray(raw.entries)) return { ok: false, error: 'failed' }
  const entries: RemoteEntry[] = []
  const seen = new Set<string>()
  let truncated = raw.truncated === true
  for (const item of raw.entries) {
    if (entries.length >= REMOTE_ENTRIES_MAX) {
      truncated = true
      break
    }
    const name = (item as { name?: unknown } | null)?.name
    if (!isRemoteName(name) || seen.has(name)) continue
    seen.add(name)
    entries.push({ name, dir: (item as { dir?: unknown }).dir === true })
  }
  return { ok: true, entries, truncated }
}

function versionOf(raw: unknown): string | null {
  return typeof raw === 'string' && REMOTE_VERSION_PATTERN.test(raw) ? raw : null
}

export function normalizeRemoteStat(raw: unknown): RemoteStatResult {
  if (!succeeded(raw)) return failureOf(raw)
  if (raw.kind === 'dir') return { ok: true, kind: 'dir' }
  if (raw.kind !== 'file') return { ok: false, error: 'failed' }
  const version = versionOf(raw.version)
  return version ? { ok: true, kind: 'file', version } : { ok: true, kind: 'file' }
}

export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

export function normalizeRemoteRead(raw: unknown): RemoteReadResult {
  if (!succeeded(raw)) return failureOf(raw)
  const version = versionOf(raw.version)
  if (typeof raw.content !== 'string' || !version) return { ok: false, error: 'failed' }
  if (
    raw.content.length > REMOTE_FILE_MAX_BYTES ||
    utf8Length(raw.content) > REMOTE_FILE_MAX_BYTES
  ) {
    return { ok: false, error: 'too-large' }
  }
  if (raw.content.includes('\u0000') || raw.content.includes('�')) {
    return { ok: false, error: 'binary' }
  }
  return { ok: true, content: raw.content, version }
}

export function normalizeRemoteWrite(raw: unknown): RemoteWriteResult {
  if (!succeeded(raw)) return failureOf(raw)
  const version = versionOf(raw.version)
  return version ? { ok: true, version } : { ok: false, error: 'failed' }
}
