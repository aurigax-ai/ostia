import { type ChannelOptions, HelperChannel, HelperFailure, runStatus } from './channel'
import type { HelperBundle } from './helper'
import { type ConnectPlan, hostKey, planHelper } from './plan'

export const IDLE_CLOSE_MS = 60_000

export interface HelperHostsDeps extends ChannelOptions {
  helper: HelperBundle
  idleCloseMs?: number
}

export class HelperHosts {
  private readonly live = new Map<string, HelperChannel>()
  private readonly opening = new Map<string, Promise<HelperChannel>>()
  private readonly users = new Map<string, number>()
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: HelperHostsDeps) {}

  async install(plan: ConnectPlan): Promise<void> {
    const { helper } = this.deps
    const words = await runStatus(planHelper(plan, 'install', helper), helper.source, this.deps)
    if (words[0] === 'installed') return
    if (words[0] === 'needs') throw new HelperFailure('needs-tool', words[1])
    throw new HelperFailure('install-failed', words.slice(1).join(' ') || undefined)
  }

  async remove(plan: ConnectPlan): Promise<void> {
    this.drop(hostKey(plan))
    const words = await runStatus(planHelper(plan, 'remove', this.deps.helper), null, this.deps)
    if (words[0] !== 'removed') throw new HelperFailure('remove-failed')
  }

  private async open(key: string, plan: ConnectPlan): Promise<HelperChannel> {
    const channel = await HelperChannel.open(planHelper(plan, 'run', this.deps.helper), this.deps)
    this.live.set(key, channel)
    channel.onClose(() => {
      if (this.live.get(key) === channel) this.live.delete(key)
      this.clearIdle(key)
    })
    return channel
  }

  async channel(plan: ConnectPlan): Promise<HelperChannel> {
    const key = hostKey(plan)
    const live = this.live.get(key)
    if (live && !live.isClosed) return live
    const pending = this.opening.get(key)
    if (pending) return pending
    const opening = this.open(key, plan).finally(() => this.opening.delete(key))
    this.opening.set(key, opening)
    const channel = await opening
    if (!this.users.get(key)) this.scheduleIdle(key)
    return channel
  }

  retain(key: string): void {
    this.users.set(key, (this.users.get(key) ?? 0) + 1)
    this.clearIdle(key)
  }

  release(key: string): void {
    const left = (this.users.get(key) ?? 0) - 1
    if (left > 0) {
      this.users.set(key, left)
      return
    }
    this.users.delete(key)
    if (this.live.has(key)) this.scheduleIdle(key)
  }

  private clearIdle(key: string): void {
    const timer = this.idle.get(key)
    if (timer) clearTimeout(timer)
    this.idle.delete(key)
  }

  private scheduleIdle(key: string): void {
    this.clearIdle(key)
    const timer = setTimeout(() => {
      this.idle.delete(key)
      if (!this.users.get(key)) this.drop(key)
    }, this.deps.idleCloseMs ?? IDLE_CLOSE_MS)
    timer.unref?.()
    this.idle.set(key, timer)
  }

  isConnected(key: string): boolean {
    const live = this.live.get(key)
    return live !== undefined && !live.isClosed
  }

  drop(key: string): void {
    this.live.get(key)?.close()
  }

  closeAll(): void {
    for (const channel of [...this.live.values()]) channel.close()
  }
}
