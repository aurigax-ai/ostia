import type { ExtensionAgentOffer } from '@shared/extensions'
import { create } from 'zustand'

interface AgentOfferState {
  offers: ExtensionAgentOffer[]
  receive: (offer: ExtensionAgentOffer) => void
  withdraw: (requestId: string) => void
  answer: (requestId: string, paneId: string | null) => void
}

export const useAgentOfferStore = create<AgentOfferState>((set) => ({
  offers: [],
  receive: (offer) => set((s) => ({ offers: [...s.offers, offer] })),
  withdraw: (requestId) =>
    set((s) => ({ offers: s.offers.filter((o) => o.requestId !== requestId) })),
  answer: (requestId, paneId) => {
    set((s) => ({ offers: s.offers.filter((o) => o.requestId !== requestId) }))
    window.ostia.extensions.answerAgentOffer(requestId, paneId)
  },
}))
