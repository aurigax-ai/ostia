import type { Translate } from '@aurigax-ai/ostia-extension-sdk'
import type { RemoteRegistry } from './registry'

const REFRESH_MS = 60_000

export interface MonitorDeps {
  registry: RemoteRegistry
  translate: () => Promise<Translate>
  locale: () => Promise<string>
  setSidebar: (item: { workspaceId: string; text: string; tone: 'ok' | 'warn' }) => Promise<unknown>
  setChip: (paneId: string, text: string) => Promise<unknown>
  clearChip: (paneId: string) => Promise<unknown>
  now?: () => number
  refreshMs?: number
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
    this.timer = setInterval(() => void this.refresh(), this.deps.refreshMs ?? REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  online(host: string): boolean {
    return this.contact.get(host)?.online ?? false
  }

  async state(host: string, online: boolean, last: number | null): Promise<void> {
    this.contact.set(host, { online, last })
    await this.show(host, online, last, (this.deps.now ?? Date.now)())
  }

  private async refresh(): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    for (const [host, { online, last }] of this.contact) {
      if (!online) await this.show(host, online, last, now)
    }
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
