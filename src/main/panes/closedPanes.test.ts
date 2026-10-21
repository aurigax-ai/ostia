import { beforeEach, describe, expect, it } from 'vitest'
import { closedLabel, forgetClosedPanes, recallClosedPane, rememberClosedPane } from './closedPanes'

const ID = '3f6a7ced-1111-4222-8333-444455556666'
const everywhere = () => true

beforeEach(forgetClosedPanes)

describe('closed panes', () => {
  it('recalls a closed pane by its id or by 8 or more characters of it', () => {
    rememberClosedPane({ externalId: ID, workspaceId: 'ws1', closedAt: 5 })
    expect(recallClosedPane(ID, everywhere)?.externalId).toBe(ID)
    expect(recallClosedPane(ID.slice(0, 8), everywhere)?.externalId).toBe(ID)
    expect(recallClosedPane(ID.slice(0, 7), everywhere)).toBeUndefined()
    expect(recallClosedPane('0000000000', everywhere)).toBeUndefined()
  })

  it('answers nothing for a pane of a workspace the caller cannot see', () => {
    rememberClosedPane({ externalId: ID, workspaceId: 'ws-far', closedAt: 5 })
    expect(recallClosedPane(ID, (workspaceId) => workspaceId === 'ws1')).toBeUndefined()
    expect(recallClosedPane(ID.slice(0, 8), (workspaceId) => workspaceId === 'ws1')).toBeUndefined()
  })

  it('does not guess between two closed panes that share a prefix', () => {
    rememberClosedPane({ externalId: `${ID.slice(0, 8)}-aaaa`, workspaceId: 'ws1', closedAt: 5 })
    rememberClosedPane({ externalId: `${ID.slice(0, 8)}-bbbb`, workspaceId: 'ws1', closedAt: 6 })
    expect(recallClosedPane(ID.slice(0, 8), everywhere)).toBeUndefined()
  })

  it('keeps the newest 256 and says when and as what a pane closed', () => {
    for (let i = 0; i < 260; i += 1) {
      rememberClosedPane({ externalId: `id-${i}`, workspaceId: 'ws1', closedAt: i })
    }
    expect(recallClosedPane('id-0', everywhere)).toBeUndefined()
    expect(recallClosedPane('id-259', everywhere)).toBeDefined()
    expect(
      closedLabel({ externalId: 'x', workspaceId: 'w', closedAt: 0, name: 'w-1241' }, 7_200_000),
    ).toBe('closed 2h ago (w-1241)')
    expect(closedLabel({ externalId: 'x', workspaceId: 'w', closedAt: 0 }, 30_000)).toBe(
      'closed 30s ago',
    )
  })
})
