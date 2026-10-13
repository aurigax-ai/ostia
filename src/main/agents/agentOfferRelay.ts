import type { ExtensionAgentOffer } from '../../shared/extensions'
import type { AgentOfferDelivery } from './extensionAgents'

export const AGENT_OFFER_TIMEOUT_MS = 120_000

export const AGENT_OFFER_CHANNEL = 'extensions:agent-offer'
export const AGENT_OFFER_WITHDRAWN_CHANNEL = 'extensions:agent-offer-withdrawn'
export const AGENT_OFFER_RESULT_CHANNEL = 'extensions:agent-offer-result'

export interface AgentOfferRelayDeps {
  windowOf: (workspaceId: string) => string | undefined
  send: (windowId: string, channel: string, payload: unknown) => boolean
  externalIdOf: (paneId: string) => string | undefined
  timeoutMs?: number
}

interface Pending {
  windowId: string
  finish: (paneId: string | null) => void
}

export interface AgentOfferRelay {
  offer: (offer: Omit<ExtensionAgentOffer, 'requestId'>) => Promise<AgentOfferDelivery>
  answer: (senderWindowId: string, requestId: unknown, paneId: unknown) => void
}

export function createAgentOfferRelay(deps: AgentOfferRelayDeps): AgentOfferRelay {
  const pending = new Map<string, Pending>()
  let seq = 0

  return {
    offer: (offer) => {
      const windowId = deps.windowOf(offer.workspaceId)
      if (!windowId) return Promise.resolve({ delivered: false })
      const requestId = `offer-${++seq}`
      return new Promise((resolve) => {
        const finish = (paneId: string | null): void => {
          clearTimeout(timer)
          pending.delete(requestId)
          resolve({ delivered: true, paneId })
        }
        const timer = setTimeout(() => {
          deps.send(windowId, AGENT_OFFER_WITHDRAWN_CHANNEL, requestId)
          finish(null)
        }, deps.timeoutMs ?? AGENT_OFFER_TIMEOUT_MS)
        pending.set(requestId, { windowId, finish })
        if (!deps.send(windowId, AGENT_OFFER_CHANNEL, { ...offer, requestId })) {
          clearTimeout(timer)
          pending.delete(requestId)
          resolve({ delivered: false })
        }
      })
    },
    answer: (senderWindowId, requestId, paneId) => {
      if (typeof requestId !== 'string') return
      const entry = pending.get(requestId)
      if (!entry || entry.windowId !== senderWindowId) return
      const external = typeof paneId === 'string' && paneId ? deps.externalIdOf(paneId) : undefined
      entry.finish(external ?? null)
    },
  }
}
