import type { AttentionState } from '@shared/types'
import { create } from 'zustand'
import { useBlocksStore } from './blocksStore'

export type AgentTurn = 'working' | 'waiting' | 'idle'

interface AgentTurnEntry {
  blockId: string
  turn: AgentTurn
}

interface AgentTurnState {
  byPane: Record<string, AgentTurnEntry | undefined>
  report: (paneId: string, state: AttentionState) => void
}

const TURNS: Partial<Record<AttentionState, AgentTurn>> = {
  working: 'working',
  waiting: 'waiting',
  done: 'idle',
  error: 'idle',
}

export const useAgentTurnStore = create<AgentTurnState>((set) => ({
  byPane: {},
  report: (paneId, state) => {
    const blockId = useBlocksStore.getState().running[paneId]
    const turn = TURNS[state]
    set((s) => ({
      byPane: { ...s.byPane, [paneId]: blockId && turn ? { blockId, turn } : undefined },
    }))
  },
}))

export function agentTurnOf(paneId: string): AgentTurn | null {
  const entry = useAgentTurnStore.getState().byPane[paneId]
  const blockId = useBlocksStore.getState().running[paneId]
  return entry && blockId !== undefined && entry.blockId === blockId ? entry.turn : null
}
