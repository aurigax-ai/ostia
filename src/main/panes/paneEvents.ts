import { postEvent, watchersOf } from '../agents/busStore'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { StampedEvent } from './paneJournal'

export const WATCH_UNTIL = ['done', 'waiting', 'error', 'command', 'exited'] as const
export type WatchUntil = (typeof WATCH_UNTIL)[number]
export const WATCH_UNTIL_DEFAULT: readonly WatchUntil[] = ['done', 'waiting', 'error', 'exited']

type PaneChange = { kind: 'attention' | 'state' | 'closed' }

const ATTENTION_EVENTS: ReadonlySet<string> = new Set(['done', 'waiting', 'error'])

export interface PaneEventsDeps {
  identity: (paneId: string) => PaneIdentity | undefined
  line: (watched: PaneIdentity, subscriber: PaneIdentity) => Promise<string | undefined>
  exited: (paneId: string) => boolean
}

export class PaneEvents {
  private readonly gone = new Set<string>()

  constructor(private readonly deps: PaneEventsDeps) {}

  onJournal = (paneId: string, event: StampedEvent): void => {
    if (event.kind === 'state' && ATTENTION_EVENTS.has(event.state)) {
      this.fire(paneId, event.state as WatchUntil)
    } else if (event.kind === 'command') {
      this.fire(paneId, 'command')
    }
  }

  onChange = (paneId: string, change: PaneChange): void => {
    if (change.kind === 'closed') {
      this.gone.delete(paneId)
      return
    }
    if (change.kind !== 'state') return
    if (!this.deps.exited(paneId)) this.gone.delete(paneId)
    else if (!this.gone.has(paneId)) {
      this.gone.add(paneId)
      this.fire(paneId, 'exited')
    }
  }

  private fire(paneId: string, kind: WatchUntil): void {
    const watched = this.deps.identity(paneId)
    if (!watched) return
    for (const watch of watchersOf(watched.externalId)) {
      if (!watch.until.includes(kind)) continue
      const subscriber = resolveExternal(watch.subscriber)
      if (subscriber?.kind !== 'pane') continue
      void this.deps.line(watched, subscriber).then(
        (line) => {
          if (line) postEvent(watched.externalId, watch.subscriber, line)
        },
        () => undefined,
      )
    }
  }
}
