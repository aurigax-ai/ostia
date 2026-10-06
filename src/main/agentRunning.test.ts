import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, SnapshotPaneNode } from '../shared/types'
import { AgentRunningPanes } from './agentRunning'

const resume = { agent: 'claude' as const, id: 'tok-1' }

function pane(id: string, extra: Partial<SnapshotPaneNode> = {}): SnapshotPaneNode {
  return { type: 'pane', id, title: id, kind: 'terminal', resume, ...extra }
}

function snapshot(panes: SnapshotPaneNode[], detached: SnapshotPaneNode[] = []): AppSnapshot {
  return {
    v: 1,
    savedAt: '',
    activeWorkspaceId: 'w1',
    groups: [],
    workspaces: [
      {
        id: 'w1',
        name: 'w',
        kind: 'terminal',
        workDir: '/w',
        root: { type: 'tabs', id: 't1', activeId: panes[0].id, children: panes },
        activePaneId: panes[0].id,
      },
    ],
    ...(detached.length > 0
      ? {
          windows: [
            {
              id: 'd1',
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              activeWorkspaceId: 'w2',
              workspaces: [
                {
                  id: 'w2',
                  name: 'd',
                  kind: 'terminal',
                  workDir: '/d',
                  root: {
                    type: 'split',
                    id: 's1',
                    direction: 'horizontal',
                    sizes: [1],
                    children: detached,
                  },
                },
              ],
            },
          ],
        }
      : {}),
  }
}

function runningIds(snap: AppSnapshot): string[] {
  const ids: string[] = []
  const json = JSON.stringify(snap, (_key, value) => {
    if (value && typeof value === 'object' && value.type === 'pane' && value.agentRunning) {
      ids.push(value.id)
    }
    return value
  })
  expect(json).toBeTruthy()
  return ids.sort()
}

describe('AgentRunningPanes', () => {
  it('marks a pane the renderer reported running, with the renderer saving it without the mark', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    expect(runningIds(book.mark(snapshot([pane('a'), pane('b')])))).toEqual(['a'])
  })

  it('keeps the mark after Ostia took the shell away, whatever the renderer saves later', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    book.report('a', false, false)
    expect(runningIds(book.mark(snapshot([pane('a')])))).toEqual(['a'])
  })

  it('clears the mark when the agent ends while its pane is attached', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    book.report('a', false, true)
    expect(runningIds(book.mark(snapshot([pane('a')])))).toEqual([])
  })

  it('clears the mark when the shell itself ended', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    book.shellEnded('a')
    expect(runningIds(book.mark(snapshot([pane('a')])))).toEqual([])
  })

  it('ignores a running report from a window that is not attached to the pane', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, false)
    expect(runningIds(book.mark(snapshot([pane('a')])))).toEqual([])
  })

  it('never marks a hibernated pane, so auto-resume leaves it asleep', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    book.report('a', false, false)
    expect(runningIds(book.mark(snapshot([pane('a', { hibernated: true })])))).toEqual([])
  })

  it('never marks a pane without a resume token', () => {
    const book = new AgentRunningPanes(() => {})
    book.report('a', true, true)
    expect(runningIds(book.mark(snapshot([pane('a', { resume: undefined })])))).toEqual([])
  })

  it('carries the saved marks of every window across a restart until they are cleared', () => {
    const book = new AgentRunningPanes(() => {})
    book.seed(
      snapshot(
        [pane('a', { agentRunning: true }), pane('b')],
        [pane('c', { agentRunning: true }), pane('d')],
      ),
    )
    const fresh = snapshot([pane('a'), pane('b')], [pane('c'), pane('d')])
    expect(runningIds(book.mark(fresh))).toEqual(['a', 'c'])
    book.report('c', false, true)
    expect(runningIds(book.mark(fresh))).toEqual(['a'])
  })

  it('says which panes had a running agent when Ostia last saved', () => {
    const book = new AgentRunningPanes(() => {})
    book.seed(snapshot([pane('a', { agentRunning: true }), pane('b')]))
    expect(book.has('a')).toBe(true)
    expect(book.has('b')).toBe(false)
  })

  it('asks for a save only when the set changes', () => {
    const onChange = vi.fn()
    const book = new AgentRunningPanes(onChange)
    book.report('a', true, true)
    book.report('a', true, true)
    book.report('a', false, false)
    book.shellEnded('b')
    expect(onChange).toHaveBeenCalledTimes(1)
    book.shellEnded('a')
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
