import { afterEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { ensureCaps } = await import('./controlElevation')
const { registerPane } = await import('../control/idRegistry')

const identity = registerPane({ windowId: '1', workspaceId: 'ws-el', paneId: 'pane-el' })
const conn = { externalId: identity.externalId, paneId: 'pane-el', workspaceId: 'ws-el' }

afterEach(() => request.mockReset())

async function refusal(outcome: 'deny' | 'timeout') {
  request.mockResolvedValue(outcome)
  return ensureCaps(conn, identity, ['all-workspaces'], 'state', '').catch((e) => e)
}

describe('ensureCaps refusals', () => {
  it('keeps the denied code first and adds a hint naming the capability and the human', async () => {
    const err = await refusal('deny')
    expect(err.message).toBe('denied: all-workspaces')
    expect(err.data.hint).toContain('all-workspaces')
    expect(err.data.hint).toContain('act on other panes and workspaces')
    expect(err.data.hint).toContain('Only the human can grant it')
    expect(err.data.hint).toContain('do not retry')
  })

  it('keeps the not-approved code first and says nobody answered', async () => {
    const err = await refusal('timeout')
    expect(err.message).toBe('not-approved: all-workspaces')
    expect(err.data.hint).toContain('Nobody answered')
  })
})
