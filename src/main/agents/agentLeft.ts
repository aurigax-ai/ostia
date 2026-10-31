import { dropName } from '../panes/paneNames'
import { type PromptOwner, shellIdle } from '../terminal/localPrompt'

export interface AgentLeftDeps {
  running: (paneId: string) => boolean
  waking: (paneId: string) => boolean
  owner: (paneId: string) => PromptOwner | undefined
  recheck: (paneId: string, again: () => void) => void
}

function atPrompt(owner: PromptOwner): boolean {
  try {
    return shellIdle(owner)
  } catch {
    return false
  }
}

export function agentLeft(deps: AgentLeftDeps, paneId: string, rechecked = false): void {
  if (deps.running(paneId) || deps.waking(paneId)) return
  const owner = deps.owner(paneId)
  if (!owner) return
  if (atPrompt(owner)) dropName(paneId)
  else if (!rechecked) deps.recheck(paneId, () => agentLeft(deps, paneId, true))
}
