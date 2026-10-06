import type { PaneAttentionPeek } from '../paneIo'

export const KEPT_AGENT_UNREPORTED =
  'its agent kept running across a restart and has not reported its state since'

export class KeptAttention {
  private readonly unreported = new Set<string>()

  reattached(paneId: string, agentRunning: boolean): void {
    if (agentRunning) this.unreported.add(paneId)
    else this.unreported.delete(paneId)
  }

  reported(paneId: string): void {
    this.unreported.delete(paneId)
  }

  peek(paneId: string): PaneAttentionPeek | undefined {
    if (!this.unreported.has(paneId)) return undefined
    return { state: 'waiting', message: KEPT_AGENT_UNREPORTED }
  }
}
