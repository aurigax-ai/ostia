import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { parseProcStat } from '../../shared/procfs'
import type { PortBridge } from './portBridge'

export interface SandboxListener {
  port: number
  process: string | null
  pid?: number
}

export type ExposeResult =
  | { ok: true; port: number }
  | { ok: false; error: 'port-in-use' | 'unsupported' | ExposeRefusal }

export type ExposeRefusal = 'not-running' | 'unix-sockets-off'

export interface SandboxPane {
  pid: number
  bridge: PortBridge | null
}

export interface PortForwarderDeps {
  onChange?: (workspaceId: string) => void
  panesOf: (workspaceId: string) => SandboxPane[]
  unixSocketsOff: (workspaceId: string) => boolean
  listenersOf?: (pids: number[]) => SandboxListener[][]
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

function descendants(roots: number[], children: Map<number, number[]>): number[] {
  const out: number[] = []
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    out.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return out
}

function namespacePid(tree: number[]): number | null {
  const own = netNamespace('self')
  return (
    tree.find((pid) => {
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

function processOfInode(pids: number[], inode: string): { pid: number; name: string } | null {
  const target = `socket:[${inode}]`
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) {
          return { pid, name: readFileSync(`/proc/${pid}/comm`, 'utf8').trim() }
        }
      }
    } catch {}
  }
  return null
}

function listenersIn(tree: number[]): SandboxListener[] {
  const pid = namespacePid(tree)
  if (pid === null) return []
  const seen = new Map<number, SandboxListener>()
  for (const [inode, port] of listeningInodes(pid)) {
    if (seen.has(port)) continue
    const owner = processOfInode(tree, inode)
    if (RUNTIME_BRIDGE_PORTS.has(port) && owner?.name === RUNTIME_BRIDGE_PROCESS) continue
    seen.set(port, owner ? { port, process: owner.name, pid: owner.pid } : { port, process: null })
  }
  return [...seen.values()]
}

export function paneListeners(pids: number[]): SandboxListener[][] {
  const children = childrenMap()
  return pids.map((pid) => listenersIn(descendants([pid], children)))
}

interface Exposure {
  server: Server
  sockets: Set<Socket>
}

export class PortForwarder {
  private readonly exposures = new Map<string, Map<number, Exposure>>()
  private readonly listenersOf: (pids: number[]) => SandboxListener[][]

  constructor(private readonly deps: PortForwarderDeps) {
    this.listenersOf = deps.listenersOf ?? paneListeners
  }

  listeners(workspaceId: string): SandboxListener[] {
    const pids = this.deps.panesOf(workspaceId).map((pane) => pane.pid)
    const seen = new Map<number, SandboxListener>()
    for (const listener of this.listenersOf(pids).flat()) {
      if (!seen.has(listener.port)) seen.set(listener.port, listener)
    }
    return [...seen.values()].sort((a, b) => a.port - b.port)
  }

  exposed(workspaceId: string): number[] {
    return [...(this.exposures.get(workspaceId)?.keys() ?? [])].sort((a, b) => a - b)
  }

  refusal(workspaceId: string): ExposeRefusal | null {
    const panes = this.deps.panesOf(workspaceId)
    if (panes.some((pane) => pane.bridge?.connected)) return null
    return panes.length > 0 && this.deps.unixSocketsOff(workspaceId)
      ? 'unix-sockets-off'
      : 'not-running'
  }

  async expose(workspaceId: string, port: number): Promise<ExposeResult> {
    if (this.exposures.get(workspaceId)?.has(port)) return { ok: true, port }
    const refusal = this.refusal(workspaceId)
    if (refusal) return { ok: false, error: refusal }
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
    this.deps.onChange?.(workspaceId)
    return { ok: true, port }
  }

  async unexpose(workspaceId: string, port: number): Promise<void> {
    const exposure = this.exposures.get(workspaceId)?.get(port)
    if (!exposure) return
    this.exposures.get(workspaceId)?.delete(port)
    this.deps.onChange?.(workspaceId)
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
    socket.on('error', () => undefined)
    const panes = this.deps.panesOf(workspaceId).filter((pane) => pane.bridge?.connected)
    const listening = this.listenersOf(panes.map((pane) => pane.pid))
    const serving = panes.find((_pane, i) => listening[i]?.some((l) => l.port === port))
    if (!serving?.bridge) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    void serving.bridge.dial(port, socket)
  }
}
