import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreItems } from '../../shared/git'
import { DEFAULT_PORTS_SETTINGS, type PortsSettings } from '../../shared/ports'
import type { PaneEntry } from '../paneList'
import type { TreeInfo } from './scan'
import { PORTS_ITEMS_CHANNEL, PortsService } from './service'

const pane = (paneId: string, workspaceId: string, pid: number): PaneEntry => ({
  paneId,
  workspaceId,
  kind: 'terminal',
  title: paneId,
  running: true,
  blockCount: 0,
  pid,
})

describe('PortsService', () => {
  let settings: PortsSettings
  let trees: Map<number, TreeInfo>
  const sent: { windowId: string; channel: string; payload: unknown }[] = []
  const listPanes = vi.fn<() => Promise<PaneEntry[]>>()
  const scan = vi.fn<(roots: number[], hostPid: number) => Promise<Map<number, TreeInfo>>>()
  let service: PortsService

  const items = (windowId: string): CoreItems | undefined =>
    sent.filter((m) => m.windowId === windowId && m.channel === PORTS_ITEMS_CHANNEL).at(-1)
      ?.payload as CoreItems | undefined
  const settle = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    settings = { ...DEFAULT_PORTS_SETTINGS }
    trees = new Map([
      [10, { ports: [5173, 3000], ssh: null }],
      [20, { ports: [], ssh: { user: 'deploy', host: 'box' } }],
    ])
    sent.length = 0
    listPanes.mockReset().mockResolvedValue([pane('ext-a', 'one', 10), pane('ext-b', 'two', 20)])
    scan
      .mockReset()
      .mockImplementation(
        async (roots) => new Map([...trees].filter(([pid]) => roots.includes(pid))),
      )
    service = new PortsService({
      settings: () => settings,
      listPanes,
      rendererPaneId: (externalId) => externalId.replace('ext-', 'pane-'),
      send: (windowId, channel, payload) => sent.push({ windowId, channel, payload }),
      scan,
      hostPid: 1,
    })
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it('scans nothing and arms no timer while no window shows a ports item', async () => {
    service.activity('command.started')
    service.setFocused(false)
    service.setFocused(true)
    service.settingsChanged()
    await settle(60_000)
    expect(service.polling).toBe(false)
    expect(service.pending).toBe(false)
    expect(listPanes).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
  })

  it('scans only the terminals of the workspaces shown, and sends the plug with a link per port', async () => {
    service.watch('w1', ['one'])
    await settle()
    expect(scan).toHaveBeenLastCalledWith([10], 1)
    expect(items('w1')).toEqual({
      sidebar: [],
      paneChips: [],
      workspaceChips: [
        {
          extId: 'ports',
          tone: 'neutral',
          workspaceId: 'one',
          id: 'ports',
          icon: 'plugs',
          text: '2',
          items: [
            { text: ':3000', url: 'http://localhost:3000/' },
            { text: ':5173', url: 'http://localhost:5173/' },
          ],
        },
      ],
    })
  })

  it('shows a foreground ssh login on its pane, by renderer pane id, and in the sidebar', async () => {
    service.watch('w1', ['two'])
    await settle()
    expect(items('w1')?.paneChips).toEqual([
      { extId: 'ports', paneId: 'pane-b', id: 'ssh', text: 'deploy@box', tone: 'brand' },
    ])
    expect(items('w1')?.sidebar).toEqual([
      {
        extId: 'ports',
        tone: 'neutral',
        workspaceId: 'two',
        key: 'ssh',
        text: 'box',
        badge: 'SSH',
        kind: 'live',
      },
    ])
  })

  it('opens ports on 127.0.0.1 when the human chose that host', async () => {
    settings = { ...settings, portHost: '127.0.0.1' }
    service.settingsChanged()
    service.watch('w1', ['one'])
    await settle()
    expect(items('w1')?.workspaceChips[0].items?.[0].url).toBe('http://127.0.0.1:3000/')
  })

  it('polls while focused and stops once the last window stops showing ports', async () => {
    service.watch('w1', ['one'])
    await settle()
    const first = scan.mock.calls.length
    await settle(settings.intervalSeconds * 1000)
    expect(scan.mock.calls.length).toBe(first + 1)
    service.setFocused(false)
    await settle(60_000)
    expect(scan.mock.calls.length).toBe(first + 1)
    service.setFocused(true)
    await settle()
    service.watch('w1', [])
    expect(service.polling).toBe(false)
    expect(service.pending).toBe(false)
    expect(items('w1')).toEqual({ sidebar: [], paneChips: [], workspaceChips: [] })
    const last = scan.mock.calls.length
    await settle(60_000)
    expect(scan.mock.calls.length).toBe(last)
  })

  it('stops when the human turns ports off', async () => {
    service.watch('w1', ['one'])
    await settle()
    settings = { ...settings, enabled: false }
    service.settingsChanged()
    expect(service.polling).toBe(false)
    expect(items('w1')?.workspaceChips).toEqual([])
  })

  it('lists every workspace for a one-off read without starting to poll', async () => {
    expect(await service.list()).toEqual([
      { workspaceId: 'one', ports: [3000, 5173], ssh: [] },
      { workspaceId: 'two', ports: [], ssh: ['box'] },
    ])
    expect(service.polling).toBe(false)
    expect(service.pending).toBe(false)
  })
})
