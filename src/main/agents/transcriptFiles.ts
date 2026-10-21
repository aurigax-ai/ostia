import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentResume } from '../../shared/agents/agentResume'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function isPlainFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function claudeTranscript(home: string, id: string, cwd?: string): string | null {
  const root = join(home, '.claude', 'projects')
  if (cwd !== undefined) {
    const path = join(root, claudeProjectDir(cwd), `${id}.jsonl`)
    return isPlainFile(path) ? path : null
  }
  for (const project of listDir(root)) {
    const path = join(root, project, `${id}.jsonl`)
    if (isPlainFile(path)) return path
  }
  return null
}

function codexTranscript(home: string, id: string): string | null {
  const root = join(home, '.codex', 'sessions')
  const newestFirst = (dir: string) => listDir(dir).sort().reverse()
  for (const year of newestFirst(root)) {
    for (const month of newestFirst(join(root, year))) {
      for (const day of newestFirst(join(root, year, month))) {
        const dir = join(root, year, month, day)
        const name = listDir(dir).find((f) => f.endsWith(`-${id}.jsonl`))
        if (name && isPlainFile(join(dir, name))) return join(dir, name)
      }
    }
  }
  return null
}

export function transcriptPath(resume: AgentResume, home = homedir()): string | null {
  return resume.agent === 'claude'
    ? claudeTranscript(home, resume.id, resume.cwd)
    : codexTranscript(home, resume.id)
}

export function readRange(path: string, fromEnd: boolean, bytes: number): string[] {
  const fd = openSync(path, READ_FLAGS)
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) throw new Error('not a regular file')
    const size = info.size
    const length = Math.min(bytes, size)
    const start = fromEnd ? size - length : 0
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (fromEnd && start > 0) lines.shift()
    if (!fromEnd && length < size) lines.pop()
    return lines
  } finally {
    closeSync(fd)
  }
}

export interface TailRead {
  lines: string[]
  truncated: boolean
}

export async function readTail(path: string, bytes: number): Promise<TailRead> {
  const handle = await open(path, READ_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    const { size } = info
    const length = Math.min(bytes, size)
    const start = size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return { lines, truncated: start > 0 }
  } finally {
    await handle.close()
  }
}

export interface TailWindow {
  lines: string[]
  truncated: boolean
  end: number
}

function completeLines(buffer: Buffer, start: number, skipPartialHead: boolean) {
  const last = buffer.lastIndexOf(0x0a)
  if (last < 0) return { lines: [] as string[], end: start }
  let from = 0
  if (skipPartialHead) {
    const first = buffer.indexOf(0x0a)
    from = first + 1
  }
  const text = from > last ? '' : buffer.subarray(from, last).toString('utf8')
  return { lines: text === '' ? [] : text.split('\n'), end: start + last + 1 }
}

export async function readTailWindow(path: string, bytes: number): Promise<TailWindow> {
  const handle = await open(path, READ_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    const length = Math.min(bytes, info.size)
    const start = info.size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return { ...completeLines(buffer, start, start > 0), truncated: start > 0 }
  } finally {
    await handle.close()
  }
}

const NEW_LINES_BYTES = 4 * 1024 * 1024
const LONGEST_LINE_BYTES = 64 * 1024 * 1024

export interface NewLines {
  lines: string[]
  end: number
  reset: boolean
}

export async function readNewLines(
  path: string,
  offset: number,
  chunk = NEW_LINES_BYTES,
  longest = LONGEST_LINE_BYTES,
): Promise<NewLines> {
  const handle = await open(path, READ_FLAGS)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a regular file')
    if (info.size < offset) return { lines: [], end: 0, reset: true }
    for (let cap = chunk; ; cap *= 2) {
      const length = Math.min(info.size - offset, cap)
      if (length === 0) return { lines: [], end: offset, reset: false }
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      const read = completeLines(buffer, offset, false)
      const stuck = read.lines.length === 0 && length === cap && length < info.size - offset
      if (!stuck) return { ...read, reset: false }
      if (cap >= longest) return { lines: [], end: offset + length, reset: false }
    }
  } finally {
    await handle.close()
  }
}
