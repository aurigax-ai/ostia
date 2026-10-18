import type { ConfirmRequest, Translate } from '@aurigax-ai/ostia-extension-sdk'
import type { OwnedScreen } from './screenRegistry'
import { type EventStream, runScreens, watchEvents } from './screensCli'

export interface DomainCardsDeps {
  confirm: (req: ConfirmRequest) => Promise<boolean>
  translate: (locale: string) => Translate
  locale: () => string
  workspaceName: (workspaceId: string) => Promise<string>
}

interface Watched {
  screen: OwnedScreen
  stream: EventStream
  asking: Set<string>
}

export class DomainCards {
  private readonly watched = new Map<string, Watched>()

  constructor(private readonly deps: DomainCardsDeps) {}

  watch(screen: OwnedScreen): void {
    if (this.watched.has(screen.id)) return
    const entry: Watched = {
      screen,
      asking: new Set(),
      stream: watchEvents(screen.id, screen.viewerToken, (event) => this.onEvent(entry, event)),
    }
    this.watched.set(screen.id, entry)
  }

  unwatch(id: string): void {
    this.watched.get(id)?.stream.stop()
    this.watched.delete(id)
  }

  private onEvent(entry: Watched, event: Record<string, unknown>): void {
    const host = typeof event.host === 'string' ? event.host : ''
    if (event.id !== entry.screen.id || !host) return
    if (event.type === 'domain-answer') {
      entry.asking.delete(host)
    } else if (event.type === 'domain-request' && !entry.asking.has(host)) {
      entry.asking.add(host)
      const port = typeof event.port === 'number' ? event.port : null
      void this.ask(entry, host, port)
    }
  }

  private async ask(entry: Watched, host: string, port: number | null): Promise<void> {
    const t = this.deps.translate(this.deps.locale())
    const { screen } = entry
    const target = port === null ? host : `${host}:${port}`
    const allowed = await this.deps
      .confirm({
        title: t('domain.title'),
        message: t('domain.message', {
          id: screen.id,
          host: target,
          workspace: await this.deps.workspaceName(screen.workspaceId),
        }),
        detail: t('domain.detail', { id: screen.id }),
        confirmLabel: t('domain.allow'),
        cancelLabel: t('domain.deny'),
      })
      .catch(() => false)
    if (!entry.asking.delete(host) || this.watched.get(screen.id) !== entry) return
    await runScreens({
      args: [allowed ? 'allow' : 'deny', screen.id, host],
      token: screen.viewerToken,
    })
  }
}
