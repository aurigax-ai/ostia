import type { Socket } from 'node:net'
import { type ProcReader, procFs } from '../manager/portalCaller'

export interface Peer {
  pid: number
  startTime: string
  seccomp: number
}

const SOL_SOCKET = 1
const SO_PEERCRED = 17
const UCRED_BYTES = 12

export function parseSeccomp(status: string): number | null {
  const match = /^Seccomp:\s*(\d+)\s*$/m.exec(status)
  return match ? Number(match[1]) : null
}

export function parseStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const field = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19]
  return field && /^\d+$/.test(field) ? field : null
}

function startTimeOf(pid: number, proc: ProcReader): string | null {
  const stat = proc.read(`/proc/${pid}/stat`)
  return stat === null ? null : parseStartTime(stat)
}

function seccompOf(pid: number, proc: ProcReader = procFs): number | null {
  const status = proc.read(`/proc/${pid}/status`)
  return status === null ? null : parseSeccomp(status)
}

export function readPeer(pid: number, proc: ProcReader = procFs): Peer | null {
  const before = startTimeOf(pid, proc)
  const seccomp = seccompOf(pid, proc)
  const after = startTimeOf(pid, proc)
  if (before === null || seccomp === null || before !== after) return null
  return { pid, startTime: before, seccomp }
}

export function sandboxedByKernel(
  peer: Peer | null,
  shellPid: number | undefined,
  proc: ProcReader = procFs,
): boolean {
  if (!peer || peer.seccomp === 0 || shellPid === undefined) return false
  const now = startTimeOf(peer.pid, proc)
  if (now !== null && now !== peer.startTime) return true
  return seccompOf(shellPid, proc) === 0
}

export type PeerPid = (socket: Socket) => Promise<number | null>

function socketFd(socket: Socket): number | null {
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd
  return typeof fd === 'number' && fd >= 0 ? fd : null
}

const peerPidOf: PeerPid = async (socket) => {
  if (process.platform !== 'linux') return null
  const fd = socketFd(socket)
  if (fd === null) return null
  try {
    const { default: koffi } = await import('koffi')
    const libc = koffi.load('libc.so.6')
    const getsockopt = libc.func(
      'int getsockopt(int fd, int level, int name, void *value, _Inout_ uint32_t *length)',
    )
    const buffer = Buffer.alloc(UCRED_BYTES)
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, buffer, [UCRED_BYTES]) !== 0) return null
    const pid = buffer.readInt32LE(0)
    return pid > 0 ? pid : null
  } catch {
    return null
  }
}

export async function peerOf(socket: Socket, pidOf: PeerPid = peerPidOf): Promise<Peer | null> {
  const pid = await pidOf(socket)
  return pid === null ? null : readPeer(pid)
}

const NEVER_FROM_SANDBOX = new Set([
  'process.run',
  'process.kill',
  'process.restart',
  'agent.run',
  'pane.setResume',
])
const OWN_PANE_ONLY: Record<string, 'pane' | 'panes'> = {
  'pane.input': 'pane',
  'pane.close': 'panes',
  'pane.wake': 'panes',
  'pane.moveTo': 'panes',
}

export function escapesSandbox(method: string, params: unknown, own: string): boolean {
  if (NEVER_FROM_SANDBOX.has(method)) return true
  const key = OWN_PANE_ONLY[method]
  if (!key) return false
  const given = (params as Record<string, unknown> | null | undefined)?.[key]
  if (given === undefined || given === null) return false
  const refs = Array.isArray(given) ? given : [given]
  return refs.length === 0 || refs.some((ref) => ref !== own)
}

export function escapesSandboxCommand(id: string, targetPaneId: string | null, own: string) {
  if (NEVER_FROM_SANDBOX.has(id)) return true
  return id in OWN_PANE_ONLY && targetPaneId !== own
}
