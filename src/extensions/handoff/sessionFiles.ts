import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs'
import { join } from 'node:path'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const WORKTREE_INFIX = '--claude-worktrees-'

const SESSION_READ_MAX_BYTES = 32 * 1024 * 1024
export const SESSION_ID_PREFIX = /^[0-9a-f][0-9a-f-]{3,35}$/

export interface SessionFile {
  id: string
  path: string
  project: string
  modified: number
}

export function projectKey(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, '-')
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function regularModified(path: string): number | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? stat.mtimeMs : null
  } catch {
    return null
  }
}

function scopeProjects(projectsDir: string, folders: readonly string[] | 'all'): string[] {
  const all = listDir(projectsDir)
  if (folders === 'all') return all
  const bases = folders.map(projectKey)
  return all.filter((name) =>
    bases.some((base) => name === base || name.startsWith(`${base}${WORKTREE_INFIX}`)),
  )
}

function sessionsOf(projectsDir: string, project: string): SessionFile[] {
  const found: SessionFile[] = []
  for (const name of listDir(join(projectsDir, project))) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(projectsDir, project, name)
    const modified = regularModified(path)
    if (modified !== null) found.push({ id: name.slice(0, -6), path, project, modified })
  }
  return found
}

export function listSessions(
  projectsDir: string,
  folders: readonly string[] | 'all',
): SessionFile[] {
  return scopeProjects(projectsDir, folders)
    .flatMap((project) => sessionsOf(projectsDir, project))
    .sort((a, b) => b.modified - a.modified)
}

export function sessionsByPrefix(projectsDir: string, prefix: string): SessionFile[] {
  if (!SESSION_ID_PREFIX.test(prefix)) return []
  return listSessions(projectsDir, 'all').filter((s) => s.id.startsWith(prefix))
}

export function readSessionLines(path: string, maxBytes = SESSION_READ_MAX_BYTES): string[] {
  const fd = openSync(path, READ_FLAGS)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('not a regular file')
    const length = Math.min(maxBytes, info.size)
    const start = info.size - length
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
    const lines = buffer.toString('utf8', 0, read).split('\n')
    if (start > 0) lines.shift()
    return lines.filter((line) => line !== '')
  } finally {
    closeSync(fd)
  }
}
