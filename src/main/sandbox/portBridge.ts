import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import { quoteArg } from '../../shared/shellQuote'

const DIAL_TIMEOUT_MS = 5000

export function bridgesPorts(platform: NodeJS.Platform, unixSockets: boolean): boolean {
  return platform === 'linux' && unixSockets
}

export function controlSocketName(id: string): string {
  return `ports-${id}.sock`
}

export function dataSocketName(id: string, port: number | string): string {
  return `ports-${id}-${port}.sock`
}

export function portBridgeCommand(dir: string, id: string): string {
  return [
    '(',
    `trap '' INT QUIT TSTP;`,
    `cd ${quoteArg(dir)} || exit;`,
    'exec </dev/null >/dev/null 2>&1;',
    'shell=$$;',
    'while kill -0 "$shell" 2>/dev/null; do',
    `socat -u UNIX-CONNECT:${controlSocketName(id)} - | while read -r port; do`,
    `case "$port" in ''|*[!0-9]*) continue;; esac;`,
    `socat UNIX-CONNECT:${dataSocketName(id, '"$port"')} TCP:127.0.0.1:"$port" &`,
    'done;',
    'sleep 1;',
    'done',
    ') &',
  ].join(' ')
}

function listenOn(server: Server, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(path, () => resolve(true))
  })
}

function pipeBoth(a: Socket, b: Socket): void {
  a.on('close', () => b.destroy())
  b.on('close', () => a.destroy())
  a.pipe(b)
  b.pipe(a)
}

interface Waiting {
  client: Socket
  timer: NodeJS.Timeout
}

interface Channel {
  server: Server
  waiting: Waiting[]
}

export class PortBridge {
  readonly command: string
  readonly id: string
  private readonly server: Server
  private readonly channels = new Map<number, Promise<Channel | null>>()
  private readonly peers = new Set<Socket>()
  private control: Socket | null = null
  private closed = false

  private constructor(
    private readonly dir: string,
    private readonly dialTimeoutMs: number,
    id: string,
  ) {
    this.id = id
    this.command = portBridgeCommand(dir, this.id)
    this.server = createServer((socket) => this.onControl(socket))
  }

  static async open(
    dir: string,
    dialTimeoutMs = DIAL_TIMEOUT_MS,
    id: string = randomBytes(4).toString('hex'),
  ): Promise<PortBridge | null> {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const bridge = new PortBridge(dir, dialTimeoutMs, id)
    if (await listenOn(bridge.server, join(dir, controlSocketName(bridge.id)))) return bridge
    return null
  }

  get connected(): boolean {
    return this.control !== null
  }

  async dial(port: number, client: Socket): Promise<void> {
    const channel = await this.channel(port)
    const control = this.control
    if (!channel || !control || client.destroyed) {
      client.destroy()
      return
    }
    const entry: Waiting = { client, timer: setTimeout(() => client.destroy(), this.dialTimeoutMs) }
    channel.waiting.push(entry)
    client.once('close', () => {
      clearTimeout(entry.timer)
      const at = channel.waiting.indexOf(entry)
      if (at >= 0) channel.waiting.splice(at, 1)
    })
    control.write(`${port}\n`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.control?.destroy()
    this.control = null
    for (const peer of this.peers) peer.destroy()
    this.server.close()
    for (const pending of this.channels.values()) {
      void pending.then((channel) => {
        if (!channel) return
        for (const { client } of channel.waiting) client.destroy()
        channel.server.close()
      })
    }
    this.channels.clear()
  }

  private onControl(socket: Socket): void {
    socket.on('error', () => undefined)
    if (this.control || this.closed) {
      socket.destroy()
      return
    }
    this.control = socket
    socket.resume()
    socket.on('close', () => {
      if (this.control === socket) this.control = null
    })
  }

  private channel(port: number): Promise<Channel | null> {
    const existing = this.channels.get(port)
    if (existing) return existing
    const waiting: Waiting[] = []
    const server = createServer((peer) => {
      peer.on('error', () => undefined)
      const next = waiting.shift()
      if (!next) {
        peer.destroy()
        return
      }
      clearTimeout(next.timer)
      this.peers.add(peer)
      peer.on('close', () => this.peers.delete(peer))
      pipeBoth(next.client, peer)
    })
    const path = join(this.dir, dataSocketName(this.id, port))
    const opened = (async (): Promise<Channel | null> => {
      if (this.closed) return null
      rmSync(path, { force: true })
      if (!(await listenOn(server, path))) return null
      if (this.closed) {
        server.close()
        return null
      }
      return { server, waiting }
    })().catch(() => null)
    this.channels.set(port, opened)
    void opened.then((channel) => {
      if (!channel && this.channels.get(port) === opened) this.channels.delete(port)
    })
    return opened
  }
}
