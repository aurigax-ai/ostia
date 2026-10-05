import { execFile } from 'node:child_process'
import { fstatSync, readFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { envName } from '../shared/appEnv'

export type CallerVerdict = 'outside' | 'inside' | 'unknown'

export interface ProcReader {
  read: (path: string) => string | null
}

export interface CallerContext {
  mainPid: number
  paneTtys: ReadonlySet<number>
  proc: ProcReader
}

const MAX_ANCESTRY = 128

export interface ProcStat {
  ppid: number
  ttyNr: number
}

export function parseProcStat(text: string): ProcStat | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const ppid = Number(fields[1])
  const ttyNr = Number(fields[4])
  if (!Number.isInteger(ppid) || !Number.isInteger(ttyNr)) return null
  return { ppid, ttyNr }
}

const TOKEN_ENTRY = `${envName('TOKEN')}=`

export function hasPaneToken(environ: string): boolean {
  return environ.split('\0').some((entry) => entry.startsWith(TOKEN_ENTRY))
}

function statOf(pid: number, proc: ProcReader): ProcStat | null {
  const text = proc.read(`/proc/${pid}/stat`)
  return text === null ? null : parseProcStat(text)
}

function descendsFromMain(pid: number, ctx: CallerContext): boolean | null {
  let current = pid
  for (let hop = 0; hop < MAX_ANCESTRY && current > 1; hop++) {
    if (current === ctx.mainPid) return true
    const stat = statOf(current, ctx.proc)
    if (!stat) return hop === 0 ? null : false
    current = stat.ppid
  }
  return false
}

export function judgeCaller(pid: number, ctx: CallerContext): CallerVerdict {
  const stat = statOf(pid, ctx.proc)
  const environ = ctx.proc.read(`/proc/${pid}/environ`)
  if (!stat || environ === null) return 'unknown'
  if (hasPaneToken(environ)) return 'inside'
  if (stat.ttyNr !== 0 && ctx.paneTtys.has(stat.ttyNr)) return 'inside'
  const descends = descendsFromMain(pid, ctx)
  if (descends === null) return 'unknown'
  return descends ? 'inside' : 'outside'
}

export function judgeCallers(pids: readonly number[], ctx: CallerContext): CallerVerdict {
  if (pids.length === 0) return 'unknown'
  let verdict: CallerVerdict = 'outside'
  for (const pid of pids) {
    const one = judgeCaller(pid, ctx)
    if (one === 'inside') return 'inside'
    if (one === 'unknown') verdict = 'unknown'
  }
  return verdict
}

const SS_LINE = /^\S+\s+\S+\s+\d+\s+\d+\s+(.+?)\s+(\d+)\s+(.+?)\s+(\d+)(?:\s+users:\((.*)\))?\s*$/

export function peerPidsFromSs(output: string, serverInode: number): number[] {
  const pids = new Set<number>()
  for (const line of output.split('\n')) {
    const match = SS_LINE.exec(line.trim())
    if (!match || Number(match[4]) !== serverInode || !match[5]) continue
    for (const pid of match[5].matchAll(/pid=(\d+)/g)) pids.add(Number(pid[1]))
  }
  return [...pids]
}

export function ttysOf(pids: Iterable<number>, proc: ProcReader): Set<number> {
  const ttys = new Set<number>()
  for (const pid of pids) {
    const stat = statOf(pid, proc)
    if (stat && stat.ttyNr !== 0) ttys.add(stat.ttyNr)
  }
  return ttys
}

export const procFs: ProcReader = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

export function socketInode(socket: Socket): number | null {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  if (typeof fd !== 'number' || fd < 0) return null
  try {
    return fstatSync(fd).ino
  } catch {
    return null
  }
}

const SS_TIMEOUT_MS = 3000

export function listUnixSockets(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ss',
      ['-xpnH'],
      { shell: false, timeout: SS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    )
  })
}

export async function callerVerdict(
  socket: Socket,
  ctx: CallerContext,
  list: () => Promise<string | null> = listUnixSockets,
): Promise<CallerVerdict> {
  const inode = socketInode(socket)
  if (inode === null) return 'unknown'
  const output = await list()
  if (output === null) return 'unknown'
  return judgeCallers(peerPidsFromSs(output, inode), ctx)
}
