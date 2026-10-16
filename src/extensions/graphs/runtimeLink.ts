import type { OstiaExtension, WireRuntimeResult } from '@aurigax-ai/ostia-extension-sdk'
import { RuntimeCallError, RuntimeClient } from '@aurigax-ai/wire'

export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'ready'; mode: string; version: string }
  | { kind: 'other-contract'; version?: string; contract?: number }
  | { kind: 'failed'; message: string }

export type LinkExt = Pick<OstiaExtension, 'wireRuntime'>

const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000]

export class RuntimeLink {
  state: LinkState = { kind: 'connecting' }
  private client: RuntimeClient | null = null
  private connecting: Promise<RuntimeClient | null> | null = null
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly ext: LinkExt,
    private readonly ready: (client: RuntimeClient) => Promise<void>,
    private readonly changed: () => void,
  ) {}

  ensure(): Promise<RuntimeClient | null> {
    if (this.client) return Promise.resolve(this.client)
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const client = await this.ensure()
    if (!client) throw new RuntimeCallError(this.refusal())
    return client.call<T>(method, params)
  }

  refusal(): string {
    if (this.state.kind === 'other-contract') return 'other-runtime'
    if (this.state.kind === 'failed') return `no-runtime: ${this.state.message}`
    return 'no-runtime'
  }

  stop(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.client?.close()
    this.client = null
  }

  private set(state: LinkState): void {
    this.state = state
    this.changed()
  }

  private async connect(): Promise<RuntimeClient | null> {
    if (this.closed) return null
    const answer: WireRuntimeResult = await this.ext.wireRuntime().catch((err: unknown) => ({
      ok: false as const,
      error: 'failed',
      message: err instanceof Error ? err.message : String(err),
    }))
    if (!answer.ok) {
      if (answer.error === 'other-contract')
        this.set({
          kind: 'other-contract',
          ...(answer.version !== undefined ? { version: answer.version } : {}),
          ...(answer.contract !== undefined ? { contract: answer.contract } : {}),
        })
      else this.set({ kind: 'failed', message: answer.message ?? answer.error })
      this.retry()
      return null
    }
    let client: RuntimeClient
    try {
      client = await RuntimeClient.connect({ socket: answer.socket, token: answer.token })
    } catch (err) {
      this.set({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      this.retry()
      return null
    }
    this.client = client
    this.retries = 0
    void client.closed.then(() => {
      if (this.client !== client) return
      this.client = null
      this.set({ kind: 'connecting' })
      this.retry()
    })
    try {
      await this.ready(client)
    } catch (err) {
      client.close()
      this.client = null
      this.set({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      this.retry()
      return null
    }
    this.set({ kind: 'ready', mode: client.hello.mode, version: client.hello.version })
    return client
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return
    const ms = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)] as number
    this.retries += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.ensure()
    }, ms)
  }
}
