import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { parseProcStat } from '../../shared/procfs'

export interface SandboxListener {
  port: number
  process: string | null
}

export type ExposeResult =
  | { ok: true; port: number }
  | { ok: false; error: 'port-in-use' | 'not-running' | 'unsupported' }

export interface PortForwarderDeps {
  pidsOf: (workspaceId: string) => number[]
}

const LISTEN = '0A'
const RUNTIME_BRIDGE_PORTS = new Set([1080, 3128])
const RUNTIME_BRIDGE_PROCESS = 'socat'
const LOOPBACK_OR_ANY = new Set([
  '0100007F',
  '00000000',
  '00000000000000000000000000000000',
  '00000000000000000000000001000000',
])

function netNamespace(pid: number | 'self'): string | null {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`)
  } catch {
    return null
  }
}

function childrenMap(): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const parsed = parseProcStat(stat)
      if (parsed) {
        const list = children.get(parsed.ppid) ?? []
        list.push(parsed.pid)
        children.set(parsed.ppid, list)
      }
    } catch {}
  }
  return children
}

function descendants(roots: number[]): number[] {
  const children = childrenMap()
  const out: number[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    out.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return out
}

export function findNamespacePid(roots: number[]): number | null {
  const own = netNamespace('self')
  return (
    descendants(roots).find((pid) => {
      const ns = netNamespace(pid)
      return ns !== null && ns !== own
    }) ?? null
  )
}

function listeningInodes(pid: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const file of ['tcp', 'tcp6']) {
    let text = ''
    try {
      text = readFileSync(`/proc/${pid}/net/${file}`, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== LISTEN) continue
      const [addr, portHex] = cols[1].split(':')
      if (!LOOPBACK_OR_ANY.has(addr)) continue
      out.set(cols[9], Number.parseInt(portHex, 16))
    }
  }
  return out
}

function processOfInode(pids: number[], inode: string): string | null {
  const target = `socket:[${inode}]`
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
          return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
        }
      }
    } catch {}
  }
  return null
}

interface Exposure {
  server: Server
  sockets: Set<Socket>
}

export class PortForwarder {
  private readonly exposures = new Map<string, Map<number, Exposure>>()

  constructor(private readonly deps: PortForwarderDeps) {}

  listeners(workspaceId: string): SandboxListener[] {
    const roots = this.deps.pidsOf(workspaceId)
    const pid = findNamespacePid(roots)
    if (pid === null) return []
    const inodes = listeningInodes(pid)
    const tree = descendants(roots)
    const seen = new Map<number, SandboxListener>()
    for (const [inode, port] of inodes) {
      if (seen.has(port)) continue
      const owner = processOfInode(tree, inode)
      if (RUNTIME_BRIDGE_PORTS.has(port) && owner === RUNTIME_BRIDGE_PROCESS) continue
      seen.set(port, { port, process: owner })
    }
    return [...seen.values()].sort((a, b) => a.port - b.port)
  }

  exposed(workspaceId: string): number[] {
    return [...(this.exposures.get(workspaceId)?.keys() ?? [])].sort((a, b) => a - b)
  }

  async expose(workspaceId: string, port: number): Promise<ExposeResult> {
    if (this.exposures.get(workspaceId)?.has(port)) return { ok: true, port }
    if (findNamespacePid(this.deps.pidsOf(workspaceId)) === null) {
      return { ok: false, error: 'not-running' }
    }
    const sockets = new Set<Socket>()
    const server = createServer((socket) => this.bridge(workspaceId, port, socket, sockets))
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (!listening) return { ok: false, error: 'port-in-use' }
    const byPort = this.exposures.get(workspaceId) ?? new Map<number, Exposure>()
    byPort.set(port, { server, sockets })
    this.exposures.set(workspaceId, byPort)
    return { ok: true, port }
  }

  async unexpose(workspaceId: string, port: number): Promise<void> {
    const exposure = this.exposures.get(workspaceId)?.get(port)
    if (!exposure) return
    this.exposures.get(workspaceId)?.delete(port)
    for (const socket of exposure.sockets) socket.destroy()
    await new Promise<void>((resolve) => exposure.server.close(() => resolve()))
  }

  async forget(workspaceId: string): Promise<void> {
    await Promise.all(this.exposed(workspaceId).map((port) => this.unexpose(workspaceId, port)))
    this.exposures.delete(workspaceId)
  }

  stopAll(): void {
    for (const workspaceId of [...this.exposures.keys()]) void this.forget(workspaceId)
  }

  private bridge(workspaceId: string, port: number, socket: Socket, sockets: Set<Socket>): void {
    const pid = findNamespacePid(this.deps.pidsOf(workspaceId))
    if (pid === null) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    const child = spawn(
      'nsenter',
      [
        '-t',
        String(pid),
        '--user',
        '--net',
        '--preserve-credentials',
        'socat',
        '-',
        `TCP:127.0.0.1:${port}`,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    socket.pipe(child.stdin)
    child.stdout.pipe(socket)
    const end = (): void => {
      sockets.delete(socket)
      socket.destroy()
      child.kill()
    }
    socket.on('error', end)
    socket.on('close', end)
    child.on('exit', end)
    child.stdin.on('error', end)
  }
}
