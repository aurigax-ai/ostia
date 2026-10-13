import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_OFFER_CHANNEL,
  AGENT_OFFER_TIMEOUT_MS,
  AGENT_OFFER_WITHDRAWN_CHANNEL,
  createAgentOfferRelay,
} from './agentOfferRelay'

const OFFER = {
  extId: 'trellis',
  extName: 'Trellis',
  workspaceId: 'w1',
  label: 'SHOP-7',
  text: 'Work on SHOP-7',
}

describe('agentOfferRelay', () => {
  let sent: { windowId: string; channel: string; payload: unknown }[]
  const owners: Record<string, string> = { w1: '7' }
  const relay = () =>
    createAgentOfferRelay({
      windowOf: (workspaceId) => owners[workspaceId],
      send: (windowId, channel, payload) => {
        sent.push({ windowId, channel, payload })
        return true
      },
      externalIdOf: (paneId) => (paneId === 'pane-1' ? 'ext-1' : undefined),
    })

  beforeEach(() => {
    sent = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the offer only in the window that holds the workspace', async () => {
    const r = relay()
    const pending = r.offer(OFFER)
    expect(sent).toEqual([
      { windowId: '7', channel: AGENT_OFFER_CHANNEL, payload: { ...OFFER, requestId: 'offer-1' } },
    ])
    r.answer('7', 'offer-1', 'pane-1')
    expect(await pending).toEqual({ delivered: true, paneId: 'ext-1' })
  })

  it('ignores an answer from another window or for another request', async () => {
    const r = relay()
    const pending = r.offer(OFFER)
    r.answer('8', 'offer-1', 'pane-1')
    r.answer('7', 'offer-2', 'pane-1')
    r.answer('7', 42, 'pane-1')
    r.answer('7', 'offer-1', null)
    expect(await pending).toEqual({ delivered: true, paneId: null })
  })

  it('reports a pane main does not know as not sent', async () => {
    const r = relay()
    const pending = r.offer(OFFER)
    r.answer('7', 'offer-1', 'pane-unknown')
    expect(await pending).toEqual({ delivered: true, paneId: null })
  })

  it('is not delivered when no window holds the workspace', async () => {
    expect(await relay().offer({ ...OFFER, workspaceId: 'gone' })).toEqual({ delivered: false })
    expect(sent).toEqual([])
  })

  it('withdraws an unanswered offer after the timeout', async () => {
    const r = relay()
    const pending = r.offer(OFFER)
    vi.advanceTimersByTime(AGENT_OFFER_TIMEOUT_MS)
    expect(await pending).toEqual({ delivered: true, paneId: null })
    expect(sent.at(-1)).toEqual({
      windowId: '7',
      channel: AGENT_OFFER_WITHDRAWN_CHANNEL,
      payload: 'offer-1',
    })
    r.answer('7', 'offer-1', 'pane-1')
  })
})
