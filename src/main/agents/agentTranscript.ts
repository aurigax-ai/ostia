import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import {
  type AgentSessionInfo,
  claudeSessionInfo,
  codexSessionInfo,
} from '../../shared/agents/agentSessionInfo'

export const TRANSCRIPT_TAIL_BYTES = 512 * 1024
const HEAD_BYTES = 64 * 1024
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

function claudeTranscript(home: string, id: string): string | null {
  const root = join(home, '.claude', 'projects')
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

export function readSessionInfo(resume: AgentResume, home = homedir()): AgentSessionInfo | null {
  const path =
    resume.agent === 'claude' ? claudeTranscript(home, resume.id) : codexTranscript(home, resume.id)
  if (!path) return null
  try {
    if (resume.agent === 'claude') {
      return claudeSessionInfo(readRange(path, true, TRANSCRIPT_TAIL_BYTES))
    }
    const head = readRange(path, false, HEAD_BYTES).slice(0, 1)
    return codexSessionInfo([...head, ...readRange(path, true, TRANSCRIPT_TAIL_BYTES)])
  } catch {
    return null
  }
}

export function registerAgentTranscriptIpc(): void {
  ipcMain.handle('agent:session-info', (_e, raw: unknown) => {
    const resume = parseAgentResume(raw)
    return resume ? readSessionInfo(resume) : null
  })
}
