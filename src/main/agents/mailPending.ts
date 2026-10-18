import type { MailPending } from '../../shared/agents/busMessages'
import type { PaneEntry } from '../panes/paneList'

export function mailPending(
  entry: Pick<PaneEntry, 'agent' | 'agentState' | 'hibernated'> | undefined,
  hooksOn: (agent: string) => boolean,
): MailPending {
  if (entry?.hibernated) return 'hibernated'
  if (!entry?.agent) return 'no-agent'
  if (!hooksOn(entry.agent)) return 'hooks-off'
  return entry.agentState === 'working' ? 'working' : 'idle-no-wake'
}
