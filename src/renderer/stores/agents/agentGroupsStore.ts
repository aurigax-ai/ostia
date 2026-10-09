import type { AgentGroupPlacement } from '@shared/permissions/reach'
import { create } from 'zustand'

interface AgentGroupsState {
  placements: AgentGroupPlacement[] | null
  setPlacements: (placements: AgentGroupPlacement[]) => void
}

export const useAgentGroupsStore = create<AgentGroupsState>((set) => ({
  placements: null,
  setPlacements: (placements) => set({ placements }),
}))

export function startAgentGroupsSync(): () => void {
  const receive = (placements: AgentGroupPlacement[]): void =>
    useAgentGroupsStore.getState().setPlacements(placements)
  const off = window.ostia.approvals.onAgentGroupsChanged(receive)
  void window.ostia.approvals
    .agentGroups()
    .then(receive)
    .catch(() => undefined)
  return off
}
