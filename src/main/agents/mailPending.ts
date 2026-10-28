import type { MailPending } from '../../shared/agents/busMessages'
import type { PaneEntry } from '../panes/paneList'

export interface MailerFacts {
  state: { draft: boolean } | undefined
  limited: boolean
}

export function mailPending(
  entry: (Pick<PaneEntry, 'agent' | 'agentState' | 'hibernated'> & { kind?: string }) | undefined,
  hooksOn: (agent: string) => boolean,
  mailer: MailerFacts = { state: undefined, limited: false },
): MailPending {
  if (entry?.hibernated) return 'hibernated'
  if (entry?.kind === 'agent') return 'agent-pane'
  if (!entry?.agent) return 'no-agent'
  if (!hooksOn(entry.agent)) return 'hooks-off'
  if (entry.agentState === 'working') return 'working'
  if (!mailer.state) return 'idle-no-wake'
  if (mailer.limited) return 'rate-limited'
  return mailer.state.draft ? 'draft' : 'idle-will-wake'
}
