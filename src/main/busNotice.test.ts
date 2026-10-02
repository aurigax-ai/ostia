import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../shared/types'
import { announceBusMessage, senderLabel } from './busNotice'
import type { PaneIdentity } from './idRegistry'
import type { PaneEntry, WorkspaceEntry } from './paneList'

function identity(paneId: string, workspaceId: string): PaneIdentity {
  return {
    kind: 'pane',
    externalId: `ext-${paneId}`,
    token: 't',
    windowId: 'w1',
    workspaceId,
    paneId,
  }
}

const from = identity('a', 'ws1')
const sameWorkspace = identity('b', 'ws1')
const otherWorkspace = identity('c', 'ws2')

function deps(title: string) {
  return {
    execCommand: vi.fn(async () => ({ ok: true }) as CommandResult),
    listPanes: async () => [{ paneId: from.externalId, title } as PaneEntry],
    listWorkspaces: async () => [{ workspaceId: 'ws1', name: 'api' } as WorkspaceEntry],
  }
}

describe('senderLabel', () => {
  it('names the sending pane by its title inside one workspace', async () => {
    expect(await senderLabel(deps('claude\x1b tests'), from, sameWorkspace)).toBe('claude tests')
  })

  it('adds the workspace when the message crosses workspaces', async () => {
    expect(await senderLabel(deps('claude'), from, otherWorkspace)).toBe('api · claude')
  })

  it('falls back to the workspace for a pane without a title', async () => {
    expect(await senderLabel(deps(''), from, sameWorkspace)).toBe('api')
  })
})

describe('announceBusMessage', () => {
  it('runs the unread mark on the receiving pane with a clipped one-line preview', async () => {
    const d = deps('claude')
    await announceBusMessage(d, from, sameWorkspace, `done\x07\n${'x'.repeat(400)}`)
    expect(d.execCommand).toHaveBeenCalledWith(
      { windowId: 'w1', workspaceId: 'ws1', paneId: 'b' },
      'attention.message',
      { from: 'claude', text: 'done' },
    )
  })

  it('still marks the pane when the sender cannot be named', async () => {
    const d = {
      ...deps('claude'),
      listPanes: async () => {
        throw new Error('window gone')
      },
    }
    await announceBusMessage(d, from, sameWorkspace, 'hi')
    expect(d.execCommand).toHaveBeenCalledWith(expect.anything(), 'attention.message', {
      from: '',
      text: 'hi',
    })
  })
})
