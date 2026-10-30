import { describe, expect, it } from 'vitest'
import { RemoteMonitor } from './monitor'
import { RemoteRegistry } from './registry'

function setup() {
  const registry = new RemoteRegistry(null)
  registry.addWorkspace('w1', { host: 'box', folder: '~', agent: 'claude' })
  registry.addTab('p1', { workspaceId: 'w1', host: 'box', pane: 'abcd1234' })
  let clock = 1_000_000
  const calls: string[] = []
  const monitor = new RemoteMonitor({
    registry,
    translate: async () => (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`,
    locale: async () => 'en',
    setSidebar: async ({ workspaceId, text, tone }) =>
      void calls.push(`sidebar ${workspaceId} ${tone} ${text}`),
    setChip: async (paneId, text) => void calls.push(`chip ${paneId} ${text}`),
    clearChip: async (paneId) => void calls.push(`clear ${paneId}`),
    now: () => clock,
  })
  return {
    monitor,
    calls,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('RemoteMonitor', () => {
  it('REM-U6 shows Online, then Offline with the last contact and a chip on each tab, then clears the chip', async () => {
    const { monitor, calls, advance } = setup()
    await monitor.state('box', true, 1_000_000)
    expect(calls).toEqual(['sidebar w1 ok online:{}', 'clear p1'])
    calls.length = 0
    advance(4 * 60_000)
    await monitor.state('box', false, 1_000_000)
    expect(calls[0]).toContain('sidebar w1 warn offline')
    expect(calls[0]).toContain('4 min. ago')
    expect(calls[1]).toBe('chip p1 reconnecting:{}')
    expect(monitor.online('box')).toBe(false)
  })

  it('RMT-U1 marks a new remote workspace at once, and a seed never overrides a known state', async () => {
    const { monitor, calls } = setup()
    await monitor.seed('box')
    expect(calls[0]).toContain('sidebar w1 warn offline')
    calls.length = 0
    await monitor.state('box', true, 1_000_000)
    calls.length = 0
    await monitor.seed('box')
    expect(calls).toEqual([])
    expect(monitor.online('box')).toBe(true)
  })
})
