import { describe, expect, it } from 'vitest'
import type { LayoutNode, PaneNode } from '../layout/types'
import { pickTargets } from './pickTargets'

function pane(id: string, kind: PaneNode['kind'], cwd?: string): PaneNode {
  return { type: 'pane', id, title: id, kind, cwd }
}

function split(...children: LayoutNode[]): LayoutNode {
  return { type: 'split', id: `s-${children.length}`, direction: 'horizontal', children, sizes: [] }
}

const workspaces = [
  { id: 'A', name: 'web' },
  { id: 'B', name: 'api' },
]

const layouts = {
  A: {
    root: split(
      pane('a-term', 'terminal', '~/web'),
      pane('a-web', 'browser'),
      pane('a-agent', 'terminal'),
    ),
  },
  B: { root: split(pane('b-term', 'terminal', '~/api'), pane('b-edit', 'editor')) },
}

describe('pickTargets', () => {
  it('lists only terminal panes, same workspace first', () => {
    const list = pickTargets({
      workspaces,
      layouts,
      sourceWorkspaceId: 'A',
      attention: {},
      touchedAt: {},
    })
    expect(list.map((t) => t.paneId)).toEqual(['a-term', 'a-agent', 'b-term'])
    expect(list.map((t) => t.sameWorkspace)).toEqual([true, true, false])
    expect(list[2].workspaceName).toBe('api')
    expect(list[0].cwd).toBe('~/web')
  })

  it('puts the most recently active terminal of the workspace first', () => {
    const list = pickTargets({
      workspaces,
      layouts,
      sourceWorkspaceId: 'A',
      attention: {},
      touchedAt: { 'a-term': 10, 'a-agent': 20, 'b-term': 99 },
    })
    expect(list[0].paneId).toBe('a-agent')
    expect(list.at(-1)?.paneId).toBe('b-term')
  })

  it('carries each pane attention state', () => {
    const list = pickTargets({
      workspaces,
      layouts,
      sourceWorkspaceId: 'A',
      attention: { 'a-agent': { state: 'waiting', unread: true, at: 1 } },
      touchedAt: {},
    })
    expect(list.find((t) => t.paneId === 'a-agent')?.state).toBe('waiting')
    expect(list.find((t) => t.paneId === 'a-term')?.state).toBe('none')
  })
})
