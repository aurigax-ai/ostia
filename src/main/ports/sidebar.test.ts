import { describe, expect, it } from 'vitest'
import type { PaneEntry } from '../panes/paneList'
import type { TreeInfo } from './scan'
import { groupByWorkspace, sidebarEntries, terminalPids } from './sidebar'

const pane = (paneId: string, workspaceId: string, pid?: number, kind = 'terminal'): PaneEntry => ({
  paneId,
  workspaceId,
  kind,
  title: paneId,
  running: false,
  blockCount: 0,
  ...(pid ? { pid } : {}),
})

describe('terminalPids', () => {
  it('takes the pid of every terminal pane that has a live pty', () => {
    expect(
      terminalPids([pane('a', 's1', 10), pane('b', 's1'), pane('c', 's1', 30, 'browser')]),
    ).toEqual([10])
  })
})

describe('groupByWorkspace', () => {
  it('merges the ports and ssh hosts of every terminal in a workspace', () => {
    const trees = new Map<number, TreeInfo>([
      [10, { ports: [{ port: 3000 }, { port: 5173, name: 'vite' }], ssh: null }],
      [
        11,
        {
          ports: [
            { port: 3000, name: 'node' },
            { port: 8080, name: 'python3' },
          ],
          ssh: { user: 'deploy', host: 'prod-1' },
        },
      ],
      [20, { ports: [], ssh: null }],
    ])
    const groups = groupByWorkspace(
      [pane('a', 's1', 10), pane('b', 's1', 11), pane('c', 's2', 20)],
      trees,
    )
    expect(groups.get('s1')).toEqual({
      ports: [
        { port: 3000, name: 'node' },
        { port: 5173, name: 'vite' },
        { port: 8080, name: 'python3' },
      ],
      ssh: ['prod-1'],
    })
    expect(groups.get('s2')).toEqual({ ports: [], ssh: [] })
  })
})

describe('sidebarEntries', () => {
  it('makes one ssh item per workspace and nothing for its ports', () => {
    const entries = sidebarEntries(
      new Map([['s1', { ports: [{ port: 3000 }], ssh: ['box', 'prod'] }]]),
    )
    expect(entries).toEqual([
      { workspaceId: 's1', key: 'ssh', text: 'box prod', badge: 'SSH', kind: 'live' },
    ])
  })

  it('shows nothing for a workspace with no ports and no ssh', () => {
    expect(sidebarEntries(new Map([['s1', { ports: [], ssh: [] }]]))).toEqual([])
  })
})
