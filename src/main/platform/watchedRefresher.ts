import { type CoreItems, NO_CORE_ITEMS } from '../../shared/boards/git'
import { WatchSets } from './watchSets'

export interface WatchedRefresherOptions {
  channel: string
  debounceMs: number
  events: ReadonlySet<string>
  send: (windowId: string, channel: string, payload: unknown) => void
  log?: (line: string) => void
}

export abstract class WatchedRefresher<Data> {
  protected watches = new WatchSets()
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private armedMs = 0
  private focused = true
  private running = false
  private again = false
  private sent = new Map<string, string>()

  constructor(private readonly options: WatchedRefresherOptions) {}

  protected abstract enabled(): boolean
  protected abstract pollMs(): number
  protected abstract read(watched: ReadonlySet<string>): Promise<Data>
  protected abstract itemsFor(ids: ReadonlySet<string>, data: Data): CoreItems
  protected published(_data: Data): void {}
  protected cleared(): void {}

  get active(): boolean {
    return this.enabled() && !this.watches.empty
  }

  get polling(): boolean {
    return this.poll !== null
  }

  get pending(): boolean {
    return this.timer !== null
  }

  watch(windowId: string, workspaceIds: unknown): void {
    if (this.watches.set(windowId, workspaceIds)) this.apply()
  }

  windowGone(windowId: string): void {
    this.sent.delete(windowId)
    if (this.watches.drop(windowId)) this.apply()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (!this.active) return
    this.armPoll()
    if (focused) this.schedule(0)
  }

  activity(type: string): void {
    if (this.active && this.options.events.has(type)) this.schedule()
  }

  stop(): void {
    this.halt()
  }

  async refresh(): Promise<void> {
    if (!this.active) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      const data = await this.read(this.watches.union())
      if (this.active) this.publish(data)
    } catch (err) {
      this.options.log?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        if (this.active) this.schedule()
      }
    }
  }

  protected apply(): void {
    if (!this.active) {
      this.halt()
      this.clear()
      return
    }
    this.armPoll()
    this.schedule(0)
  }

  protected schedule(delay = this.options.debounceMs): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.again = false
  }

  private clear(): void {
    this.cleared()
    for (const windowId of this.sent.keys()) {
      this.options.send(windowId, this.options.channel, NO_CORE_ITEMS)
    }
    this.sent.clear()
  }

  protected armPoll(): void {
    const ms = this.pollMs()
    if (this.poll && this.focused && this.armedMs === ms) return
    if (this.poll) clearInterval(this.poll)
    this.armedMs = ms
    this.poll = this.focused ? setInterval(() => void this.refresh(), ms) : null
  }

  private publish(data: Data): void {
    const { channel, send } = this.options
    const watching = new Map(this.watches.windows())
    for (const windowId of [...this.sent.keys()]) {
      if (watching.has(windowId)) continue
      this.sent.delete(windowId)
      send(windowId, channel, NO_CORE_ITEMS)
    }
    for (const [windowId, ids] of watching) {
      const items = this.itemsFor(ids, data)
      const text = JSON.stringify(items)
      if (this.sent.get(windowId) === text) continue
      this.sent.set(windowId, text)
      send(windowId, channel, items)
    }
    this.published(data)
  }
}
