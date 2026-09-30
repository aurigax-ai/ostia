import type { WindowSummary } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { globalWorkspaceOrder, latestRemoteUnread, remoteWorkspacesOf } from './windowWorkspaces'

const summary = (id: string, unreadAt = 0) => ({
  id,
  name: id,
  workDir: `/${id}`,
  state: 'idle' as const,
  unreadAt,
  panes: [],
})

const LIST: WindowSummary[] = [
  { windowId: '1', detached: false, workspaces: [summary('a'), summary('b')] },
  { windowId: '2', detached: true, workspaces: [summary('c', 30)] },
  { windowId: '3', detached: true, workspaces: [summary('d', 20)] },
]

describe('remoteWorkspacesOf', () => {
  it('lists only the workspaces other windows hold', () => {
    expect(remoteWorkspacesOf(LIST, '2').map((w) => [w.id, w.windowId])).toEqual([
      ['a', '1'],
      ['b', '1'],
      ['d', '3'],
    ])
  })
})

describe('globalWorkspaceOrder', () => {
  it('orders the main window first, then detached windows, using the live local order', () => {
    expect(globalWorkspaceOrder(LIST, '1', ['b', 'a']).map((s) => s.id)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ])
  })

  it('keeps the same order seen from a detached window', () => {
    expect(globalWorkspaceOrder(LIST, '2', ['c'])).toEqual([
      { id: 'a', windowId: '1' },
      { id: 'b', windowId: '1' },
      { id: 'c', windowId: '2' },
      { id: 'd', windowId: '3' },
    ])
  })

  it('falls back to the local workspaces before the first list arrives', () => {
    expect(globalWorkspaceOrder([], '1', ['a'])).toEqual([{ id: 'a', windowId: '1' }])
  })
})

describe('latestRemoteUnread', () => {
  it('picks the newest unread in another window only when it beats the local one', () => {
    expect(latestRemoteUnread(LIST, '1', 10)?.id).toBe('c')
    expect(latestRemoteUnread(LIST, '1', 40)).toBeNull()
    expect(latestRemoteUnread(LIST, '2', 0)?.id).toBe('d')
  })
})
