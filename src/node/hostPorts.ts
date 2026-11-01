import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { parseLsofListeners, parsePsTable } from '../main/ports/darwin'
import {
  addOwner,
  type ListeningSocket,
  parseNetTcp,
  portsForHolders,
  processName,
  socketInode,
  sortedPorts,
} from '../main/ports/procfs'
import type { HostPort } from '../shared/remote/remotePorts'

const PROC = '/proc'
const TOOL_TIMEOUT_MS = 5000
const TOOL_MAX_OUTPUT = 8 * 1024 * 1024

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function toolOutput(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_MAX_OUTPUT, encoding: 'utf8' },
      (_err, stdout) => resolve(stdout),
    )
  })
}

export function userSockets(sockets: ListeningSocket[], uid: number): ListeningSocket[] {
  return sockets.filter((s) => s.uid === uid)
}

async function linuxHolders(
  wanted: Set<string>,
): Promise<{ name: string | undefined; inodes: string[] }[]> {
  const pids = (await readdir(PROC).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n))
  const holders = await Promise.all(
    pids.map(async (pid) => {
      const fds = await readdir(`${PROC}/${pid}/fd`).catch(() => [] as string[])
      const links = await Promise.all(
        fds.map((fd) => readlink(`${PROC}/${pid}/fd/${fd}`).catch(() => '')),
      )
      const inodes = links.map(socketInode).filter((i): i is string => i !== null)
      if (!inodes.some((i) => wanted.has(i))) return null
      const exe = await readlink(`${PROC}/${pid}/exe`).catch(() => '')
      const comm = (await readText(`${PROC}/${pid}/comm`)).trim() || undefined
      return { name: processName(exe, comm), inodes }
    }),
  )
  return holders.filter((h): h is { name: string | undefined; inodes: string[] } => h !== null)
}

async function scanLinux(uid: number): Promise<HostPort[]> {
  const [v4, v6] = await Promise.all([readText(`${PROC}/net/tcp`), readText(`${PROC}/net/tcp6`)])
  const sockets = userSockets([...parseNetTcp(v4), ...parseNetTcp(v6)], uid)
  if (sockets.length === 0) return []
  return portsForHolders(sockets, await linuxHolders(new Set(sockets.map((s) => s.inode))))
}

async function scanDarwin(uid: number): Promise<HostPort[]> {
  const [ps, lsof] = await Promise.all([
    toolOutput('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,comm=']),
    toolOutput('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(uid), '-F', 'pn']),
  ])
  const byPid = new Map(parsePsTable(ps).map((p) => [p.pid, p]))
  const owners = new Map<number, string | undefined>()
  for (const [pid, ports] of parseLsofListeners(lsof)) {
    for (const port of ports) addOwner(owners, port, byPid.get(pid)?.comm)
  }
  return sortedPorts(owners)
}

export function scanHostPorts(): Promise<HostPort[]> {
  const uid = process.getuid?.()
  if (uid === undefined) return Promise.resolve([])
  if (process.platform === 'linux') return scanLinux(uid)
  if (process.platform === 'darwin') return scanDarwin(uid)
  return Promise.resolve([])
}

export function samePorts(a: HostPort[], b: HostPort[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
