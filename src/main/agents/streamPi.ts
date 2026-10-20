import type { StreamEvent } from '../../shared/agents/agentStream'
import type { PiStream } from '../agent/piStream'
import type { StreamSource } from './streamSource'

export function piSource(stream: PiStream): StreamSource {
  let off: (() => void) | null = null
  let sink: ((events: StreamEvent[]) => void) | null = null
  let buffered: StreamEvent[] = []
  return {
    backfill: async (turns) => {
      off = stream.subscribe((events) => {
        if (sink) sink(events)
        else buffered.push(...events)
      })
      return { events: stream.snapshot(turns), truncated: false }
    },
    live: (emit) => {
      sink = emit
      if (buffered.length > 0) emit(buffered)
      buffered = []
    },
    close: () => {
      off?.()
      off = null
      sink = null
    },
  }
}
