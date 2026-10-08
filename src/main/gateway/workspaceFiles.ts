import type { Dirent, Stats } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { expandHome, resolveSafe } from '../pathGuard'
import { HOME_HIDDEN_FILES, WORKDIR_HIDDEN_FILES, folderProblem } from '../sandbox/srtConfig'
import { type SandboxReadRules, visibleInSandbox } from '../sandbox/visibility'

const FS_READ_MAX_BYTES = 256 * 1024

type FileEntryKind = 'file' | 'dir' | 'link'

interface WorkspaceFileEntry {
  name: string
  kind: FileEntryKind
  size: number
  mtime: number
}

interface WorkspaceFileRead {
  text?: string
  base64?: string
  size: number
  truncated: boolean
}

export interface PhoneFileScope {
  home: string
  dataDirs: readonly string[]
  rules: SandboxReadRules
}

export const PHONE_HIDDEN_PATHS: readonly string[] = [
  ...HOME_HIDDEN_FILES,
  ...WORKDIR_HIDDEN_FILES,
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gh',
  '.netrc',
  '.git-credentials',
  '.docker/config.json',
  '.npmrc',
  '.env',
]

const HIDDEN_NAME_PREFIXES: readonly string[] = ['.env.']

function containsRun(segments: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= segments.length; start++) {
    if (run.every((part, i) => segments[start + i] === part)) return true
  }
  return false
}

function isHiddenFromPhone(relativePath: string): boolean {
  const segments = relativePath.split(sep).filter((part) => part !== '' && part !== '.')
  if (segments.some((part) => HIDDEN_NAME_PREFIXES.some((prefix) => part.startsWith(prefix)))) {
    return true
  }
  return PHONE_HIDDEN_PATHS.some((hidden) => containsRun(segments, hidden.split('/')))
}

type WorkspaceFileError =
  | 'workspace-too-broad'
  | 'outside-workspace'
  | 'not-found'
  | 'not-a-directory'
  | 'not-a-file'

export type WorkspaceFileOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkspaceFileError }

const utf8 = new TextDecoder('utf-8', { fatal: true })

function fail<T>(error: WorkspaceFileError): WorkspaceFileOutcome<T> {
  return { ok: false, error }
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function workspaceRoot(
  workDir: string,
  scope: PhoneFileScope,
): Promise<WorkspaceFileOutcome<string>> {
  const root = await realOrNull(resolve(expandHome(workDir)))
  if (root === null) return fail('not-found')
  if (folderProblem(root, scope)) return fail('workspace-too-broad')
  return { ok: true, value: root }
}

async function locate(
  workDir: string,
  path: string,
  scope: PhoneFileScope,
): Promise<WorkspaceFileOutcome<{ root: string; real: string }>> {
  const located = await workspaceRoot(workDir, scope)
  if (!located.ok) return located
  const root = located.value
  if (isAbsolute(path) || path.includes('\0')) return fail('outside-workspace')
  const lexical = resolveSafe(resolve(root, path), [root])
  if (lexical === null) return fail('outside-workspace')
  if (isHiddenFromPhone(relative(root, lexical))) return fail('not-found')
  const real = await realOrNull(lexical)
  if (real === null) {
    const link = await lstat(lexical).catch(() => null)
    return fail(link?.isSymbolicLink() ? 'outside-workspace' : 'not-found')
  }
  if (resolveSafe(real, [root]) === null || !visibleInSandbox(real, scope.rules)) {
    return fail('outside-workspace')
  }
  if (isHiddenFromPhone(relative(root, real))) return fail('not-found')
  return { ok: true, value: { root, real } }
}

function kindOf(entry: Dirent): FileEntryKind {
  if (entry.isSymbolicLink()) return 'link'
  return entry.isDirectory() ? 'dir' : 'file'
}

export async function listWorkspaceFiles(
  workDir: string,
  path: string,
  scope: PhoneFileScope,
): Promise<WorkspaceFileOutcome<WorkspaceFileEntry[]>> {
  const located = await locate(workDir, path, scope)
  if (!located.ok) return located
  const { root, real: dir } = located.value
  const info = await stat(dir).catch(() => null)
  if (!info) return fail('not-found')
  if (!info.isDirectory()) return fail('not-a-directory')
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!dirents) return fail('not-found')
  const entries: WorkspaceFileEntry[] = []
  for (const dirent of dirents) {
    const full = join(dir, dirent.name)
    if (!visibleInSandbox(full, scope.rules) || isHiddenFromPhone(relative(root, full))) continue
    const own: Stats | null = await lstat(full).catch(() => null)
    if (!own) continue
    entries.push({
      name: dirent.name,
      kind: kindOf(dirent),
      size: own.size,
      mtime: Math.floor(own.mtimeMs),
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, value: entries }
}

function decodeText(bytes: Buffer, truncated: boolean): string | null {
  if (bytes.includes(0)) return null
  const cuts = truncated ? [0, 1, 2, 3] : [0]
  for (const cut of cuts) {
    try {
      return utf8.decode(bytes.subarray(0, bytes.length - cut))
    } catch {}
  }
  return null
}

function readLimit(maxBytes: unknown): number {
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0) {
    return FS_READ_MAX_BYTES
  }
  return Math.min(maxBytes, FS_READ_MAX_BYTES)
}

export async function readWorkspaceFile(
  workDir: string,
  path: string,
  maxBytes: unknown,
  scope: PhoneFileScope,
): Promise<WorkspaceFileOutcome<WorkspaceFileRead>> {
  const located = await locate(workDir, path, scope)
  if (!located.ok) return located
  const handle = await open(located.value.real, 'r').catch(() => null)
  if (!handle) return fail('not-found')
  try {
    const info = await handle.stat()
    if (!info.isFile()) return fail('not-a-file')
    const limit = readLimit(maxBytes)
    const buffer = Buffer.alloc(Math.min(limit, info.size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    const truncated = info.size > bytesRead
    const text = decodeText(bytes, truncated)
    return {
      ok: true,
      value: {
        ...(text === null ? { base64: bytes.toString('base64') } : { text }),
        size: info.size,
        truncated,
      },
    }
  } finally {
    await handle.close()
  }
}
