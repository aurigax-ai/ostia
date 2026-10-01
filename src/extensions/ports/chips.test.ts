import { describe, expect, it } from 'vitest'
import type { PaneInfo } from '../sdk'
import { paneChipValues } from './chips'
import type { TreeInfo } from './scan'

const pane = (paneId: string, pid?: number, kind = 'terminal'): PaneInfo => ({
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

  it('gives a terminal with listeners an icon chip with its port count and one link per port', () => {
    expect(paneChipValues([pane('a', 10)], trees, 'localhost')).toEqual([
      {
        paneId: 'a',
        id: 'ports',
        icon: 'plugs',
        text: '2',
        items: [
          { text: ':5173', url: 'http://localhost:5173/' },
          { text: ':3000', url: 'http://localhost:3000/' },
        ],
      },
    ])
  })

  it('lists at most the chip item limit, while the count says how many listen', () => {
    const many = new Map<number, TreeInfo>([
      [20, { ports: Array.from({ length: 25 }, (_, i) => 30000 + i), ssh: null }],
    ])
    const [chip] = paneChipValues([pane('m', 20)], many, 'localhost')
    expect(chip?.text).toBe('25')
    expect(chip?.items).toHaveLength(20)
  })

  it('gives a terminal running ssh a login chip with user@host', () => {
    expect(paneChipValues([pane('b', 11)], trees, 'localhost')).toEqual([
      { paneId: 'b', id: 'ssh', text: 'deploy@build-box', tone: 'brand' },
    ])
  })

  it('uses the configured host in the port link', () => {
    expect(paneChipValues([pane('a', 10)], trees, '127.0.0.1')[0]?.items?.[0]?.url).toBe(
      'http://127.0.0.1:5173/',
    )
  })

  it('gives nothing to idle terminals, panes without a pty or other kinds', () => {
    expect(
      paneChipValues([pane('c', 12), pane('d'), pane('e', 10, 'browser')], trees, 'localhost'),
    ).toEqual([])
  })
})
