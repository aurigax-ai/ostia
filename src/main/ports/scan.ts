import { execFile } from 'node:child_process'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { type ProcEntry, parseProcStat } from '../../shared/common/procfs'
import { parseLsofListeners, parsePsTable, splitPsArgs } from './darwin'
import {
  type ListeningSocket,
  childrenOf,
  parseNetTcp,
  portsForInodes,
  processTree,
  socketInode,
} from './procfs'
import { type SshLogin, sshArgs, sshLogin } from './ssh'

export interface TreeInfo {
  ports: number[]
  ssh: SshLogin | null
}

const PROC = '/proc'
const TOOL_TIMEOUT_MS = 5000
const TOOL_MAX_OUTPUT = 8 * 1024 * 1024

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

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function linuxProcTable(): Promise<ProcEntry[]> {
  const names = await readdir(PROC).catch(() => [] as string[])
  const entries = await Promise.all(
    names.filter((n) => /^\d+$/.test(n)).map((n) => readText(`${PROC}/${n}/stat`)),
  )
  return entries.map(parseProcStat).filter((p): p is ProcEntry => p !== null)
}

async function linuxListening(): Promise<ListeningSocket[]> {
  const [v4, v6] = await Promise.all([readText(`${PROC}/net/tcp`), readText(`${PROC}/net/tcp6`)])
  return [...parseNetTcp(v4), ...parseNetTcp(v6)]
}

async function socketInodes(pid: number): Promise<string[]> {
  const fds = await readdir(`${PROC}/${pid}/fd`).catch(() => [] as string[])
  const links = await Promise.all(
    fds.map((fd) => readlink(`${PROC}/${pid}/fd/${fd}`).catch(() => '')),
  )
  return links.map(socketInode).filter((i): i is string => i !== null)
}

function foregroundSsh(tree: number[], byPid: Map<number, ProcEntry>): ProcEntry | null {
  for (const pid of tree) {
    const p = byPid.get(pid)
    if (p && p.comm === 'ssh' && p.tpgid > 0 && p.pgrp === p.tpgid) return p
  }
  return null
}

async function scanLinux(roots: number[], hostPid: number): Promise<Map<number, TreeInfo>> {
  const [procs, listening, hostInodes] = await Promise.all([
    linuxProcTable(),
    linuxListening(),
    socketInodes(hostPid),
  ])
  const inherited = new Set(hostInodes)
  const sockets = listening.filter((s) => !inherited.has(s.inode))
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const children = childrenOf(procs)
  const out = new Map<number, TreeInfo>()
  for (const root of roots) {
    if (!byPid.has(root)) continue
    const tree = processTree(root, children)
    let ports: number[] = []
    if (sockets.length > 0) {
      const inodes = new Set((await Promise.all(tree.map(socketInodes))).flat())
      ports = portsForInodes(sockets, inodes)
    }
    const ssh = foregroundSsh(tree, byPid)
    const argv = ssh ? (await readText(`${PROC}/${ssh.pid}/cmdline`)).split('\0') : []
    out.set(root, { ports, ssh: ssh ? sshLogin(sshArgs(argv)) : null })
  }
  return out
}

async function scanDarwin(roots: number[], hostPid: number): Promise<Map<number, TreeInfo>> {
  const [ps, lsof] = await Promise.all([
    toolOutput('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,comm=']),
    toolOutput('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']),
  ])
  const procs = parsePsTable(ps)
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const children = childrenOf(procs)
  const listeners = parseLsofListeners(lsof)
  const inherited = new Set(listeners.get(hostPid) ?? [])
  const out = new Map<number, TreeInfo>()
  for (const root of roots) {
    if (!byPid.has(root)) continue
    const tree = processTree(root, children)
    const owned = tree.flatMap((pid) => listeners.get(pid) ?? []).filter((p) => !inherited.has(p))
    const ports = [...new Set(owned)].sort((a, b) => a - b)
    const ssh = foregroundSsh(tree, byPid)
    let login: SshLogin | null = null
    if (ssh) {
      const args = await toolOutput('ps', ['-o', 'args=', '-p', String(ssh.pid)])
      login = sshLogin(sshArgs(splitPsArgs(args)))
    }
    out.set(root, { ports, ssh: login })
  }
  return out
}

export function scanTrees(roots: number[], hostPid: number): Promise<Map<number, TreeInfo>> {
  if (roots.length === 0) return Promise.resolve(new Map())
  if (process.platform === 'linux') return scanLinux(roots, hostPid)
  if (process.platform === 'darwin') return scanDarwin(roots, hostPid)
  return Promise.resolve(new Map())
}
