import { type ChildProcess, spawn } from 'node:child_process'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { HostRequest, HostResponse, HostToMain, MainToHost } from './protocol'

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
}

export class SandboxHost {
  private child: ChildProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, (res: HostResponse) => void>()
  private dead = false

  constructor(private readonly deps: SandboxHostDeps) {}

  async start(config: SandboxRuntimeConfig): Promise<void> {
    const child = spawn(this.deps.nodePath, [this.deps.hostScript], {
      env: { ...(this.deps.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.resume()
    child.on('message', (message: HostToMain) => this.onMessage(message))
    child.on('exit', () => {
      this.dead = true
      for (const resolve of this.pending.values()) {
        resolve({ id: -1, ok: false, error: 'sandbox host exited' })
      }
      this.pending.clear()
      this.deps.onExit?.()
    })
    await this.call({ type: 'init', config })
  }

  get alive(): boolean {
    return this.child !== null && !this.dead
  }

  async wrap(command: string, binShell: string): Promise<string> {
    const res = await this.call({ type: 'wrap', command, binShell })
    if (!res.wrapped) throw new SandboxHostError('sandbox host returned no command')
    return res.wrapped
  }

  async update(config: SandboxRuntimeConfig): Promise<void> {
    await this.call({ type: 'update', config })
  }

  async cleanup(): Promise<void> {
    if (this.alive) await this.call({ type: 'cleanup' })
  }

  stop(): void {
    if (this.child && !this.dead) this.child.disconnect()
  }

  private post(message: MainToHost): void {
    this.child?.send(message)
  }

  private call(request: Request): Promise<HostResponse & { ok: true }> {
    if (!this.child || this.dead) {
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
