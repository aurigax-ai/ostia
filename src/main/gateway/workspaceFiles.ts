import type { Dirent, Stats } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { expandHome, resolveSafe } from '../pathGuard'
import { type SandboxReadRules, visibleInSandbox } from '../sandbox/visibility'

export const FS_READ_MAX_BYTES = 256 * 1024

export type FileEntryKind = 'file' | 'dir' | 'link'

export interface WorkspaceFileEntry {
  name: string
  kind: FileEntryKind
  size: number
  mtime: number
}

export interface WorkspaceFileRead {
  text?: string
  base64?: string
  size: number
  truncated: boolean
}

export type WorkspaceFileError =
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

async function locate(
  workDir: string,
  path: string,
  rules: SandboxReadRules,
): Promise<WorkspaceFileOutcome<string>> {
  if (isAbsolute(path) || path.includes('\0')) return fail('outside-workspace')
  const root = await realOrNull(resolve(expandHome(workDir)))
  if (root === null) return fail('not-found')
  const lexical = resolveSafe(resolve(root, path), [root])
  if (lexical === null) return fail('outside-workspace')
  const real = await realOrNull(lexical)
  if (real === null) {
    const link = await lstat(lexical).catch(() => null)
    return fail(link?.isSymbolicLink() ? 'outside-workspace' : 'not-found')
  }
  if (resolveSafe(real, [root]) === null || !visibleInSandbox(real, rules)) {
    return fail('outside-workspace')
  }
  return { ok: true, value: real }
}

function kindOf(entry: Dirent): FileEntryKind {
  if (entry.isSymbolicLink()) return 'link'
  return entry.isDirectory() ? 'dir' : 'file'
}

export async function listWorkspaceFiles(
  workDir: string,
  path: string,
  rules: SandboxReadRules,
): Promise<WorkspaceFileOutcome<WorkspaceFileEntry[]>> {
  const located = await locate(workDir, path, rules)
  if (!located.ok) return located
  const dir = located.value
  const info = await stat(dir).catch(() => null)
  if (!info) return fail('not-found')
  if (!info.isDirectory()) return fail('not-a-directory')
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!dirents) return fail('not-found')
  const entries: WorkspaceFileEntry[] = []
  for (const dirent of dirents) {
    const full = join(dir, dirent.name)
    if (!visibleInSandbox(full, rules)) continue
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
  rules: SandboxReadRules,
): Promise<WorkspaceFileOutcome<WorkspaceFileRead>> {
  const located = await locate(workDir, path, rules)
  if (!located.ok) return located
  const handle = await open(located.value, 'r').catch(() => null)
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
