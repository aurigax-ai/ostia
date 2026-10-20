import type { Dict } from '@shared/app/dict'
import type { AttentionState, WorkspaceLiveState } from '@shared/attention/attention'

export function stateLabel(d: Dict, state: AttentionState | WorkspaceLiveState): string {
  switch (state) {
    case 'working':
      return d.rail.stateWorking
    case 'waiting':
      return d.rail.stateWaiting
    case 'done':
      return d.rail.stateDone
    case 'error':
      return d.rail.stateError
    default:
      return d.rail.stateIdle
  }
}
