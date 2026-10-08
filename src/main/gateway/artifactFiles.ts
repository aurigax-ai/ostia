import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type WorkspaceFileEntry,
  type WorkspaceFileOutcome,
  type WorkspaceFileRead,
  fail,
  readFileSlice,
} from './workspaceFiles'

const FOLDER_DEPTH = 1

function segmentsOf(path: string): string[] | null {
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) return null
  const segments = path.split('/').filter((part) => part !== '' && part !== '.')
  return segments.includes('..') ? null : segments
}

async function kindAt(path: string): Promise<'file' | 'dir' | null> {
  const info = await lstat(path).catch(() => null)
  if (info?.isFile()) return 'file'
  return info?.isDirectory() ? 'dir' : null
}

async function folderAt(root: string, segments: string[]): Promise<string | null> {
  let dir = root
  for (const segment of segments) {
    dir = join(dir, segment)
    if ((await kindAt(dir)) !== 'dir') return null
  }
  return dir
}

export async function listArtifactFiles(
  root: string,
  path: string,
): Promise<WorkspaceFileOutcome<WorkspaceFileEntry[]>> {
  const segments = segmentsOf(path)
  if (!segments) return fail('outside-workspace')
  if (segments.length > FOLDER_DEPTH) return fail('not-found')
  if (segments.length === 0 && (await kindAt(root)) === null) return { ok: true, value: [] }
  const dir = await folderAt(root, segments)
  if (!dir)
    return fail(
      (await kindAt(join(root, ...segments))) === 'file' ? 'not-a-directory' : 'not-found',
    )
  const names = await readdir(dir).catch(() => null)
  if (!names) return fail('not-found')
  const entries: WorkspaceFileEntry[] = []
  for (const name of names) {
    const info = await lstat(join(dir, name)).catch(() => null)
    const kind = info?.isFile() ? 'file' : info?.isDirectory() ? 'dir' : null
    if (!info || !kind || (kind === 'dir' && segments.length === FOLDER_DEPTH)) continue
    entries.push({ name, kind, size: info.size, mtime: Math.floor(info.mtimeMs) })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, value: entries }
}

export async function locateArtifactFile(
  root: string,
  path: string,
): Promise<WorkspaceFileOutcome<string>> {
  const segments = segmentsOf(path)
  if (!segments) return fail('outside-workspace')
  if (segments.length === 0 || segments.length > FOLDER_DEPTH + 1) return fail('not-found')
  const dir = await folderAt(root, segments.slice(0, -1))
  if (!dir) return fail('not-found')
  const file = join(dir, segments[segments.length - 1])
  const kind = await kindAt(file)
  if (kind === 'dir') return fail('not-a-file')
  if (kind !== 'file') return fail('not-found')
  return { ok: true, value: file }
}

export async function readArtifactFile(
  root: string,
  path: string,
  maxBytes: unknown,
  offset: unknown,
): Promise<WorkspaceFileOutcome<WorkspaceFileRead>> {
  const located = await locateArtifactFile(root, path)
  if (!located.ok) return located
  return readFileSlice(located.value, maxBytes, offset)
}
