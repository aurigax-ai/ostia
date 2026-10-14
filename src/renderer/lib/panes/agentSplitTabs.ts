const madeByAgents = new Set<string>()

export function markAgentSplitTab(tabId: string): void {
  madeByAgents.add(tabId)
}

export function isAgentSplitTab(tabId: string): boolean {
  return madeByAgents.has(tabId)
}

export function forgetAgentSplitTab(tabId: string): void {
  madeByAgents.delete(tabId)
}
