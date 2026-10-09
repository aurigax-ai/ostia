import { describe, expect, it } from 'vitest'
import type { PaneEntry } from '../panes/paneList'
import { paneChipValues, workspaceChipValues } from './chips'
import type { TreeInfo } from './scan'

const pane = (paneId: string, pid?: number, kind = 'terminal'): PaneEntry => ({
  paneId,
  workspaceId: 's1',
  kind,
  title: paneId,
  running: true,
  blockCount: 0,
  ...(pid ? { pid } : {}),
})

describe('paneChipValues', () => {
  const trees = new Map<number, TreeInfo>([
    [10, { ports: [5173, 3000], ssh: null }],
    [11, { ports: [], ssh: { user: 'deploy', host: 'build-box' } }],
    [12, { ports: [], ssh: null }],
  ])

  it('gives a terminal running ssh a login chip with user@host', () => {
    expect(paneChipValues([pane('b', 11)], trees)).toEqual([
      { paneId: 'b', id: 'ssh', text: 'deploy@build-box', tone: 'brand' },
    ])
  })

  it('gives no pane chip for listening ports, idle terminals, panes without a pty or other kinds', () => {
    expect(
      paneChipValues([pane('a', 10), pane('c', 12), pane('d'), pane('e', 11, 'browser')], trees),
    ).toEqual([])
  })
})

describe('workspaceChipValues', () => {
  it('gives a workspace with listeners one icon chip with the port count and a link per port', () => {
    const groups = new Map([
      ['s1', { ports: [3000, 5173], ssh: [] }],
      ['s2', { ports: [], ssh: ['box'] }],
    ])
    expect(workspaceChipValues(groups, 'localhost')).toEqual([
      {
        workspaceId: 's1',
        id: 'ports',
        icon: 'plugs',
        text: '2',
        items: [
          { text: ':3000', url: 'http://localhost:3000/' },
          { text: ':5173', url: 'http://localhost:5173/' },
        ],
      },
    ])
  })

  it('lists at most the chip item limit, while the count says how many listen', () => {
    const ports = Array.from({ length: 25 }, (_, i) => 30000 + i)
    const [chip] = workspaceChipValues(new Map([['s1', { ports, ssh: [] }]]), 'localhost')
    expect(chip?.text).toBe('25')
    expect(chip?.items).toHaveLength(20)
  })

  it('uses the configured host in the port link', () => {
    const groups = new Map([['s1', { ports: [5173], ssh: [] }]])
    expect(workspaceChipValues(groups, '127.0.0.1')[0]?.items?.[0]?.url).toBe(
      'http://127.0.0.1:5173/',
    )
  })
})
