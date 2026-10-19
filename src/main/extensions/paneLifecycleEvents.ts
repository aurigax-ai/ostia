import type {
  ExtensionEventPayloads,
  PaneLifecycleEventState,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'

export class PaneLifecycleEvents {
  constructor(
    private readonly deps: {
      identity: (paneId: string) => { externalId: string; workspaceId: string } | undefined
      emit: (payload: ExtensionEventPayloads['pane.lifecycle']) => void
      noted?: (paneId: string) => void
    },
  ) {}

  change(paneId: string, state: PaneLifecycleEventState): void {
    this.deps.noted?.(paneId)
    const identity = this.deps.identity(paneId)
    if (!identity) return
    this.deps.emit({ paneId: identity.externalId, workspaceId: identity.workspaceId, state })
  }
}
