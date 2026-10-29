import type { Translate } from '@aurigax-ai/ostia-extension-sdk'
import type { RemoteRegistry } from './registry'

const POLL_MS = 15_000

export interface MonitorDeps {
  registry: RemoteRegistry
  ping: (host: string) => Promise<unknown>
  translate: () => Promise<Translate>
  locale: () => Promise<string>
  setSidebar: (item: { workspaceId: string; text: string; tone: 'ok' | 'warn' }) => Promise<unknown>
  setChip: (paneId: string, text: string) => Promise<unknown>
  clearChip: (paneId: string) => Promise<unknown>
  now?: () => number
  pollMs?: number
}

interface Contact {
  online: boolean
  last: number | null
}

function ago(locale: string, ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  return minutes < 1 ? format.format(0, 'minute') : format.format(-minutes, 'minute')
}

export class RemoteMonitor {
  private readonly contact = new Map<string, Contact>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  online(host: string): boolean {
    return this.contact.get(host)?.online ?? false
  }

  async poll(): Promise<void> {
    await Promise.all(this.deps.registry.hosts().map((host) => this.check(host)))
  }

  async check(host: string): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    const before = this.contact.get(host)
    let online = true
    try {
      await this.deps.ping(host)
    } catch {
      online = false
    }
    const last = online ? now : (before?.last ?? null)
    this.contact.set(host, { online, last })
    await this.show(host, online, last, now)
  }

  private async show(
    host: string,
    online: boolean,
    last: number | null,
    now: number,
  ): Promise<void> {
    const t = await this.deps.translate()
    const text = online
      ? t('online')
      : t('offline', {
          host,
          ago: last === null ? t('never') : ago(await this.deps.locale(), now - last),
        })
    for (const workspaceId of this.deps.registry.workspacesOn(host)) {
      await this.deps.setSidebar({ workspaceId, text, tone: online ? 'ok' : 'warn' })
    }
    for (const [paneId] of this.deps.registry.tabsOf(host)) {
      if (online) await this.deps.clearChip(paneId)
      else await this.deps.setChip(paneId, t('reconnecting'))
    }
  }
}
