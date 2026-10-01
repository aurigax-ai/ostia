import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '../../shared/approvals'
import { DomainRequests } from './domainRequests'

function setup(opts: { sandboxed?: boolean; blocked?: string[] } = {}) {
  const asks: { workspaceId: string; host: string; resolve: (o: ApprovalOutcome) => void }[] = []
  const stored: string[] = []
  const session: string[] = []
  const requests = new DomainRequests({
    isSandboxed: () => opts.sandboxed ?? true,
    blockedDomains: () => opts.blocked ?? [],
    ask: ({ workspaceId, host }) =>
      new Promise<ApprovalOutcome>((resolve) => asks.push({ workspaceId, host, resolve })),
    allowWorkspace: (_ws, domain) => stored.push(domain),
    allowUntilRestart: (_ws, domain) => session.push(domain),
    now: () => 1000,
  })
  return { requests, asks, stored, session }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('DomainRequests', () => {
  it('SBX-C38 stores a domain the human allows for the workspace from an agent request', async () => {
    const { requests, asks, stored } = setup()
    const res = requests.request('ws', 'pane', 'example.com')
    await tick()
    expect(asks).toHaveLength(1)
    asks[0].resolve('workspace')
    await expect(res).resolves.toEqual({ ok: true, domain: 'example.com' })
    expect(stored).toEqual(['example.com'])
  })

  it('SBX-C39 keeps an until-restart answer out of the store', async () => {
    const { requests, asks, stored, session } = setup()
    const res = requests.request('ws', 'pane', 'example.com')
    await tick()
    asks[0].resolve('session')
    await expect(res).resolves.toEqual({ ok: true, domain: 'example.com' })
    expect(stored).toEqual([])
    expect(session).toEqual(['example.com'])
  })

  it('SBX-C40 refuses a wildcard, IP, localhost or malformed host without a card', async () => {
    const { requests, asks } = setup()
    for (const host of ['*', '127.0.0.1', 'localhost', 'exa mple.com', '*:22']) {
      await expect(requests.request('ws', 'pane', host)).resolves.toMatchObject({
        ok: false,
        error: 'invalid-domain',
      })
    }
    expect(asks).toHaveLength(0)
  })

  it('SBX-C41 refuses a request from a workspace that is not sandboxed', async () => {
    const { requests, asks } = setup({ sandboxed: false })
    await expect(requests.request('ws', 'pane', 'example.com')).resolves.toMatchObject({
      ok: false,
      error: 'not-sandboxed',
    })
    expect(asks).toHaveLength(0)
  })

  it('SBX-C42 holds a blocked connection until the human allows it', async () => {
    const { requests, asks, stored } = setup()
    const held = requests.onBlocked('ws', 'example.com', 443)
    await tick()
    expect(asks).toHaveLength(1)
    asks[0].resolve('workspace')
    await expect(held).resolves.toBe(true)
    expect(stored).toEqual(['example.com'])
  })

  it('SBX-C43 shares one card between connections to the same host and counts them', async () => {
    const { requests, asks } = setup()
    const held = Array.from({ length: 21 }, () => requests.onBlocked('ws', 'example.com', 443))
    await tick()
    expect(asks).toHaveLength(1)
    asks[0].resolve('session')
    await expect(Promise.all(held)).resolves.toEqual(Array(21).fill(true))
    expect(requests.refusals('ws')).toEqual([])
  })

  it('SBX-C44 refuses a denied host at once until restart, and the Allow button still works', async () => {
    const { requests, asks, stored } = setup()
    const first = requests.onBlocked('ws', 'example.com', 443)
    await tick()
    asks[0].resolve('timeout')
    await expect(first).resolves.toBe(false)
    await expect(requests.onBlocked('ws', 'example.com', 443)).resolves.toBe(false)
    expect(asks).toHaveLength(1)
    expect(requests.refusals('ws')).toEqual([{ host: 'example.com', count: 2, last: 1000 }])
    requests.allowFromView('ws', 'example.com')
    expect(stored).toEqual(['example.com'])
    expect(requests.refusals('ws')).toEqual([])
    const later = requests.onBlocked('ws', 'example.com', 443)
    await expect(later).resolves.toBe(true)
  })

  it('refuses an agent request for a host on the blocked list without showing a card', async () => {
    const { requests, asks, stored } = setup({ blocked: ['ads.example.com', '*.tracker.test'] })
    for (const host of ['ads.example.com', 'ADS.example.com:443', 'pixel.tracker.test']) {
      await expect(requests.request('ws', 'pane', host)).resolves.toEqual({
        ok: false,
        error: 'denied',
      })
    }
    expect(asks).toHaveLength(0)
    expect(stored).toEqual([])
    const allowed = requests.request('ws', 'pane', 'example.com')
    await tick()
    expect(asks).toHaveLength(1)
    asks[0].resolve('deny')
    await allowed
  })
})
