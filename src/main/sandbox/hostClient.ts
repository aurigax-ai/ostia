import { type ChildProcess, spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { PackageRef } from '../../shared/sandbox/packages'
import { JsonLines, connectHostChannel, writeMessage } from './hostChannel'
import type { PackageBlockReason, PackagePolicy } from './packagePolicy'
import {
  HOST_PROTOCOL_VERSION,
  type HostRequest,
  type HostResponse,
  type HostToMain,
  type MainToHost,
} from './protocol'

const HELLO_WAIT_MS = 5000

export class SandboxHostError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message)
  }
}

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = Distribute<HostRequest>

export interface SandboxHostDeps {
  nodePath: string
  hostScript: string
  env?: NodeJS.ProcessEnv
  onAsk: (host: string, port: number | undefined) => Promise<boolean>
  onExit?: () => void
  onPackageBlocked?: (pkg: PackageRef, reason: PackageBlockReason) => void
  onViolations?: (lines: string[]) => void
}

export class SandboxHost {
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private seq = 0
  private readonly pending = new Map<number, (res: HostResponse) => void>()
  private dead = false
  private hello: ((protocol: number) => void) | null = null

  constructor(private readonly deps: SandboxHostDeps) {}

  async start(config: SandboxRuntimeConfig, packages?: PackagePolicy): Promise<void> {
    const child = spawn(this.deps.nodePath, [this.deps.hostScript], {
      env: { ...(this.deps.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.resume()
    child.on('message', (message: HostToMain) => this.onMessage(message))
    child.on('exit', () => this.gone())
    await this.call({ type: 'init', config, ...(packages ? { packages } : {}) })
  }

  async attach(
    channel: string,
    config: SandboxRuntimeConfig,
    packages: PackagePolicy | undefined,
    fresh: boolean,
  ): Promise<void> {
    const socket = await connectHostChannel(channel)
    this.socket = socket
    const greeted = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), HELLO_WAIT_MS)
      this.hello = (protocol) => {
        clearTimeout(timer)
        resolve(protocol)
      }
      socket.once('close', () => {
        clearTimeout(timer)
        resolve(null)
      })
    })
    const lines = new JsonLines((message) => this.onMessage(message as HostToMain))
    socket.on('data', (chunk: Buffer) => lines.push(chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.gone())
    const protocol = await greeted
    this.hello = null
    if (protocol !== HOST_PROTOCOL_VERSION) {
      socket.destroy()
      throw new SandboxHostError(
        `the sandbox host speaks protocol ${protocol ?? 'unknown'}, this app speaks ${HOST_PROTOCOL_VERSION}`,
      )
    }
    await this.call({ type: fresh ? 'init' : 'update', config, ...(packages ? { packages } : {}) })
  }

  get alive(): boolean {
    return (this.child !== null || this.socket !== null) && !this.dead
  }

  release(): void {
    this.socket?.end()
  }

  private gone(): void {
    if (this.dead) return
    this.dead = true
    for (const resolve of this.pending.values()) {
      resolve({ id: -1, ok: false, error: 'sandbox host exited' })
    }
    this.pending.clear()
    this.deps.onExit?.()
  }

  async wrap(
    command: string,
    binShell: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
  ): Promise<string> {
    const res = await this.call({
      type: 'wrap',
      command,
      binShell,
      ...(customConfig ? { customConfig } : {}),
    })
    if (!res.wrapped) throw new SandboxHostError('sandbox host returned no command')
    return res.wrapped
  }

  async update(config: SandboxRuntimeConfig, packages?: PackagePolicy): Promise<void> {
    await this.call({ type: 'update', config, ...(packages ? { packages } : {}) })
  }

  async cleanup(): Promise<void> {
    if (this.alive) await this.call({ type: 'cleanup' })
  }

  stop(): void {
    if (this.dead) return
    if (this.child) this.child.disconnect()
    else if (this.socket) {
      const socket = this.socket
      void this.call({ type: 'shutdown' })
        .catch(() => undefined)
        .finally(() => socket.end())
    }
  }

  private post(message: MainToHost): void {
    if (this.socket) writeMessage(this.socket, message)
    else this.child?.send(message)
  }

  private call(request: Request): Promise<HostResponse & { ok: true }> {
    if ((!this.child && !this.socket) || this.dead) {
      return Promise.reject(new SandboxHostError('sandbox host is not running'))
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.ok) resolve(res)
        else reject(new SandboxHostError(res.error, res.missing))
      })
      this.post({ ...request, id } as HostRequest)
    })
  }

  private onMessage(message: HostToMain): void {
    if ('type' in message && message.type === 'hello') {
      if (Number.isInteger(message.protocol)) this.hello?.(message.protocol)
      return
    }
    if ('type' in message && message.type === 'package-blocked') {
      this.deps.onPackageBlocked?.(message.pkg, message.reason)
      return
    }
    if ('type' in message && message.type === 'violations') {
      if (Array.isArray(message.lines)) {
        this.deps.onViolations?.(message.lines.filter((line) => typeof line === 'string'))
      }
      return
    }
    if ('type' in message) {
      void this.deps
        .onAsk(message.host, message.port)
        .catch(() => false)
        .then((allow) => this.post({ type: 'ask-answer', askId: message.askId, allow }))
      return
    }
    const resolve = this.pending.get(message.id)
    this.pending.delete(message.id)
    resolve?.(message)
  }
}
