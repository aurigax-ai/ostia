import type { ExtensionEventPayloads, PaneAttentionEventState } from '../../shared/extensions'

const STATES: Record<string, PaneAttentionEventState> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
  none: 'cleared',
}

export class PaneAttentionEvents {
  private last = new Map<string, PaneAttentionEventState>()

  constructor(
    private readonly deps: {
      identity: (paneId: string) => { externalId: string; workspaceId: string } | undefined
      emit: (payload: ExtensionEventPayloads['pane.attention']) => void
    },
  ) {}

  change(paneId: string, state: unknown, _message?: unknown): void {
    const next = typeof state === 'string' ? STATES[state] : undefined
    if (!next || this.last.get(paneId) === next) return
    if (next === 'cleared' && !this.last.has(paneId)) return
    this.last.set(paneId, next)
    const identity = this.deps.identity(paneId)
    if (!identity) return
    this.deps.emit({ paneId: identity.externalId, workspaceId: identity.workspaceId, state: next })
  }

  forget(paneId: string): void {
    this.last.delete(paneId)
  }
}
