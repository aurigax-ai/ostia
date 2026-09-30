import { describe, expect, it } from 'vitest'
import type { PaneInfo } from '../sdk'
import { CHIP_TEXT_MAX, paneChipValues, portsText } from './chips'
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

describe('portsText', () => {
  it('lists every port while it fits', () => {
    expect(portsText([3000])).toBe(':3000')
    expect(portsText([3000, 5173, 8080])).toBe(':3000 :5173 :8080')
  })

  it('cuts the list with a count of the rest instead of going past the chip limit', () => {
    const ports = Array.from({ length: 12 }, (_, i) => 30000 + i)
    const text = portsText(ports)
    expect(text.length).toBeLessThanOrEqual(CHIP_TEXT_MAX)
    expect(text).toMatch(/^:30000 :30001 .* \+\d+$/)
    const shown = text.split(' ').filter((t) => t.startsWith(':')).length
    expect(text.endsWith(`+${ports.length - shown}`)).toBe(true)
  })
})

describe('paneChipValues', () => {
  const trees = new Map<number, TreeInfo>([
    [10, { ports: [5173, 3000], ssh: null }],
    [11, { ports: [], ssh: { user: 'deploy', host: 'build-box' } }],
    [12, { ports: [], ssh: null }],
  ])

  it('gives a terminal with listeners a ports chip that links its first port', () => {
    expect(paneChipValues([pane('a', 10)], trees, 'localhost')).toEqual([
      { paneId: 'a', id: 'ports', text: ':5173 :3000', url: 'http://localhost:5173/' },
    ])
  })

  it('gives a terminal running ssh a login chip with user@host', () => {
    expect(paneChipValues([pane('b', 11)], trees, 'localhost')).toEqual([
      { paneId: 'b', id: 'ssh', text: 'deploy@build-box', tone: 'brand' },
    ])
  })

  it('uses the configured host in the port link', () => {
    expect(paneChipValues([pane('a', 10)], trees, '127.0.0.1')[0]?.url).toBe(
      'http://127.0.0.1:5173/',
    )
  })

  it('gives nothing to idle terminals, panes without a pty or other kinds', () => {
    expect(
      paneChipValues([pane('c', 12), pane('d'), pane('e', 10, 'browser')], trees, 'localhost'),
    ).toEqual([])
  })
})
