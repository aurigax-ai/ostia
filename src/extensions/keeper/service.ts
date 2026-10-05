import {
  type ExtensionIcon,
  type SidebarTone,
  type ToolRun,
  runTool,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  APPROVALS_PATH,
  DEFAULT_INTERVALS,
  type KeeperApproval,
  type PollIntervals,
  isAllowedKeeperCall,
  newTickets,
  nextPollDelay,
  parseApprovals,
  parseDaemonStatus,
  parseUiUrl,
} from './keeper'
import { type Strings, stringsFor } from './strings'

export interface KeeperHost {
  setSidebarItem: (item: {
    key: string
    text: string
    icon?: ExtensionIcon
    tone?: SidebarTone
  }) => Promise<unknown>
  notifyPanel: (title: string, body?: string, path?: string) => Promise<unknown>
  log: (line: string) => void
}

export interface KeeperServiceOptions {
  host: KeeperHost
  bin?: string
  now?: () => number
  delayFor?: typeof nextPollDelay
}

export type KeeperState = 'unknown' | 'not-installed' | 'down' | 'ready'

const SIDEBAR_KEY = 'approvals'

export class KeeperService {
  private readonly bin: string
  private installed = true
  private focused = false
  private failures = 0
  private pending: KeeperApproval[] = []
  private seen = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking: Promise<void> | null = null
  private itemShown = false
  private stopped = false
  private intervals: PollIntervals = DEFAULT_INTERVALS
  private notifies = true
  state: KeeperState = 'unknown'
  locale = 'en'

  constructor(private readonly opts: KeeperServiceOptions) {
    this.bin = opts.bin ?? 'keeper'
  }

  get strings(): Strings {
    return stringsFor(this.locale)
  }

  approvals(): KeeperApproval[] {
    return this.pending
  }

  failureCount(): number {
    return this.failures
  }

  private async run(args: string[]): Promise<ToolRun> {
    if (!isAllowedKeeperCall(args)) throw new Error(`refusing keeper ${args.join(' ')}`)
    const res = await runTool(this.bin, args, { timeoutMs: 10_000 })
    if (res.missing) this.installed = false
    return res
  }

  async daemonRunning(): Promise<boolean> {
    const res = await this.run(['daemon', 'status'])
    if (res.missing) {
      this.state = 'not-installed'
      return false
    }
    const status = res.code === 0 ? parseDaemonStatus(res.stdout) : null
    this.state = status?.running ? 'ready' : 'down'
    return this.state === 'ready'
  }

  async uiUrl(): Promise<string | null> {
    if (!(await this.daemonRunning())) return null
    const res = await this.run(['ui'])
    return res.code === 0 ? parseUiUrl(res.stdout) : null
  }

  unavailableMessage(): string {
    return this.state === 'not-installed' ? this.strings.notInstalled : this.strings.daemonDown
  }

  tick(): Promise<void> {
    this.ticking ??= this.poll().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      if (!(await this.daemonRunning())) {
        this.failures += this.installed ? 1 : 0
        await this.update([])
        return
      }
      const res = await this.run(['approve', '--json'])
      const list = res.code === 0 ? parseApprovals(res.stdout) : null
      if (!list) {
        this.failures += 1
        this.opts.host.log(`keeper approve --json failed: ${res.stderr.trim().slice(0, 200)}`)
        await this.update([])
        return
      }
      this.failures = 0
      await this.update(list)
    } finally {
      this.schedule()
    }
  }

  private async update(list: KeeperApproval[]): Promise<void> {
    const fresh = newTickets(this.seen, list)
    this.pending = list
    this.seen = new Set(list.map((a) => a.ticket))
    const s = this.strings
    if (list.length > 0) {
      await this.opts.host.setSidebarItem({
        key: SIDEBAR_KEY,
        text: s.sidebar(list.length),
        icon: 'shield',
        tone: 'warn',
      })
      this.itemShown = true
    } else if (this.itemShown) {
      await this.opts.host.setSidebarItem({ key: SIDEBAR_KEY, text: '' })
      this.itemShown = false
    }
    if (fresh.length > 0 && this.notifies) {
      const first = list.find((a) => a.ticket === fresh[0])
      await this.opts.host.notifyPanel(
        s.needsApproval,
        s.notifyBody(fresh.length, first),
        APPROVALS_PATH,
      )
    }
  }

  private schedule(): void {
    if (this.stopped) return
    const delay = (this.opts.delayFor ?? nextPollDelay)(
      {
        installed: this.installed,
        pending: this.pending.length,
        focused: this.focused,
        failures: this.failures,
      },
      this.intervals,
    )
    if (delay === null) return
    this.timer = setTimeout(() => void this.tick(), delay)
  }

  configure(opts: { intervals: PollIntervals; notify: boolean }): void {
    this.intervals = opts.intervals
    this.notifies = opts.notify
    if (!this.timer || this.ticking) return
    clearTimeout(this.timer)
    this.timer = null
    this.schedule()
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    if (focused) {
      this.installed = true
      void this.tick()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
