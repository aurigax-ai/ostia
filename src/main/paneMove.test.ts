import { describe, expect, it, vi } from 'vitest'
import { type MovingPane, checkPaneMove } from './paneMove'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

function deps(
  over: {
    panes?: Record<string, MovingPane>
    sandboxed?: string[]
    scratch?: string[]
  } = {},
) {
  const owners: Record<string, string> = { a: '7', b: '7', c: '9' }
  const panes: Record<string, MovingPane> = over.panes ?? {
    p1: { windowId: '7', workspaceId: 'a' },
    p2: { windowId: '7', workspaceId: 'a' },
  }
  return {
    ownerWindow: (id: string) => owners[id],
    paneOf: (id: string) => panes[id],
    isSandboxed: (id: string) => (over.sandboxed ?? []).includes(id),
    isScratch: (id: string) => (over.scratch ?? []).includes(id),
  }
}

const refused = (error: string) => ({ ok: false, error })

describe('checkPaneMove', () => {
  it('allows panes of one workspace into another workspace of the same window', () => {
    expect(checkPaneMove(deps(), '7', 'a', 'b', ['p1', 'p2'])).toEqual({ ok: true })
    expect(checkPaneMove(deps(), '7', 'a', 'b', ['p1'])).toEqual({ ok: true })
  })

  it('refuses workspaces of another window, the same workspace and malformed input', () => {
    expect(checkPaneMove(deps(), '7', 'a', 'c', ['p1'])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '9', 'a', 'b', ['p1'])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '7', 'a', 'a', ['p1'])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '7', 'a', 'b', [])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '7', 'a', 'b', ['p1', 'p1'])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '7', 'a', 'b', 'p1')).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps(), '7', 1, 'b', ['p1'])).toEqual(refused('not-owned'))
  })

  it('refuses a pane that lives in another workspace or window', () => {
    const panes = {
      p1: { windowId: '7', workspaceId: 'b' },
      p2: { windowId: '9', workspaceId: 'a' },
    }
    expect(checkPaneMove(deps({ panes }), '7', 'a', 'b', ['p1'])).toEqual(refused('not-owned'))
    expect(checkPaneMove(deps({ panes }), '7', 'a', 'b', ['p2'])).toEqual(refused('not-owned'))
  })

  it('never moves the manager pane', () => {
    const panes = { m: { windowId: '7', workspaceId: 'a', manager: true as const } }
    expect(checkPaneMove(deps({ panes }), '7', 'a', 'b', ['m'])).toEqual(refused('manager'))
  })

  it('never moves into or out of a scratch or sandboxed workspace', () => {
    for (const side of ['a', 'b']) {
      expect(checkPaneMove(deps({ scratch: [side] }), '7', 'a', 'b', ['p1'])).toEqual(
        refused('scratch'),
      )
      expect(checkPaneMove(deps({ sandboxed: [side] }), '7', 'a', 'b', ['p1'])).toEqual(
        refused('sandbox'),
      )
    }
  })
})
