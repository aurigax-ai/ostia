import type { StreamEvent } from '../../shared/agents/agentStream'

interface StreamBackfill {
  events: StreamEvent[]
  truncated: boolean
}

export interface StreamSource {
  backfill: (turns: number) => Promise<StreamBackfill>
  live: (emit: (events: StreamEvent[]) => void) => void
  close: () => void
}
