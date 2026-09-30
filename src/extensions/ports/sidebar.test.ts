import { describe, expect, it } from 'vitest'
import type { PaneInfo } from '../sdk'
import type { TreeInfo } from './scan'
import { MAX_PORTS_PER_WORKSPACE, groupByWorkspace, sidebarEntries, terminalPids } from './sidebar'

const pane = (paneId: string, workspaceId: string, pid?: number, kind = 'terminal'): PaneInfo => ({
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
      [10, { ports: [5173, 3000], ssh: null }],
      [11, { ports: [3000, 8080], ssh: 'prod-1' }],
      [20, { ports: [], ssh: null }],
    ])
    const groups = groupByWorkspace(
      [pane('a', 's1', 10), pane('b', 's1', 11), pane('c', 's2', 20)],
      trees,
    )
    expect(groups.get('s1')).toEqual({ ports: [3000, 5173, 8080], ssh: ['prod-1'] })
    expect(groups.get('s2')).toEqual({ ports: [], ssh: [] })
  })
})

describe('sidebarEntries', () => {
  it('makes one clickable item per port and one ssh item, capped per workspace', () => {
    const ports = Array.from({ length: MAX_PORTS_PER_WORKSPACE + 2 }, (_, i) => 3000 + i)
    const entries = sidebarEntries(new Map([['s1', { ports, ssh: ['box'] }]]))
    expect(entries[0]).toEqual({ workspaceId: 's1', key: 'ssh', text: 'box', icon: 'server' })
    expect(entries[1]).toEqual({
      workspaceId: 's1',
      key: 'port:3000',
      text: ':3000',
      url: 'http://localhost:3000/',
    })
    expect(entries).toHaveLength(1 + MAX_PORTS_PER_WORKSPACE)
  })

  it('shows nothing for a workspace with no ports and no ssh', () => {
    expect(sidebarEntries(new Map([['s1', { ports: [], ssh: [] }]]))).toEqual([])
  })
})
