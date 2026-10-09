import { afterEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn(async () => 'once' as const)

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { ensureCaps } = await import('./controlElevation')
const { setCapFilter } = await import('../control/controlAuth')
const { registerPane } = await import('../control/idRegistry')

const identity = registerPane({ windowId: '1', workspaceId: 'ws-sbx', paneId: 'pane-sbx' })
const conn = { externalId: identity.externalId, paneId: 'pane-sbx', workspaceId: 'ws-sbx' }

afterEach(() => {
  request.mockClear()
  setCapFilter(() => true)
})

describe('ensureCaps in a sandboxed workspace', () => {
  it('SBX-C50 refuses all-workspaces without a card when the workspace does not allow it', async () => {
    setCapFilter((_conn, cap) => cap !== 'all-workspaces')
    await expect(
      ensureCaps(conn, identity, ['all-workspaces'], 'pane.list --all', ''),
    ).rejects.toThrow('sandboxed: all-workspaces')
    expect(request).not.toHaveBeenCalled()
  })

  it('SBX-C51 asks the human normally once the workspace allows other workspaces', async () => {
    setCapFilter(() => true)
    await ensureCaps(conn, identity, ['all-workspaces'], 'pane.list --all', '')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
