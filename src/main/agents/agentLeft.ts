import { dropName } from '../panes/paneNames'

export interface AgentLeftDeps {
  waking: (paneId: string) => boolean
  sandboxed: (paneId: string) => boolean | undefined
  program: (paneId: string) => string | null
}

export function agentLeft(deps: AgentLeftDeps, paneId: string): void {
  if (deps.waking(paneId)) return
  const sandboxed = deps.sandboxed(paneId)
  if (sandboxed !== false || deps.program(paneId) !== null) return
  dropName(paneId)
}
