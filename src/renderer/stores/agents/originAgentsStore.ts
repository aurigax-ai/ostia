import type { OriginAgents } from '@shared/windows/windowsApi'
import { create } from 'zustand'

interface OriginAgentsState {
  byWorkspace: Record<string, OriginAgents | null>
  setAll: (byWorkspace: Record<string, OriginAgents | null>) => void
}

export const useOriginAgentsStore = create<OriginAgentsState>((set) => ({
  byWorkspace: {},
  setAll: (byWorkspace) => set({ byWorkspace }),
}))
