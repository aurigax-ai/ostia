import { afterEach, describe, expect, it } from 'vitest'
import type { TreeInfo } from '../extensions/ports/scan'
import type { PaneInfo } from '../extensions/sdk'
import type { ExtensionEventType, ExtensionSettingValues } from '../shared/extensions'
import { PORTS_EXTENSION, PortsBoard, type PortsBoardHost } from './portsBoard'

type Listener = (type: ExtensionEventType, payload: unknown) => void

function fakeHost() {
  const sidebar = new Map<string, Record<string, unknown>>()
  const paneChips = new Map<string, Record<string, unknown>>()
  const workspaceChips = new Map<string, Record<string, unknown>>()
  const listeners = new Set<Listener>()
  const watchers = new Set<() => void>()
  const state = { enabled: true, settings: {} as ExtensionSettingValues, published: 0 }
  const put =
    (store: Map<string, Record<string, unknown>>, key: (p: Record<string, unknown>) => string) =>
    (extId: string, params: unknown) => {
      const p = params as Record<string, unknown>
      expect(extId).toBe(PORTS_EXTENSION)
      state.published += 1
      if (p.text) store.set(key(p), p)
      else store.delete(key(p))
      return { ok: true as const }
    }
  const host: PortsBoardHost = {
    isEnabled: () => state.enabled,
    settingValuesOf: () => state.settings,
    publishSidebarItem: put(sidebar, (p) => `${p.workspaceId}/${p.key}`),
    publishPaneChip: put(paneChips, (p) => `${p.paneId}/${p.id}`),
    publishWorkspaceChip: put(workspaceChips, (p) => `${p.workspaceId}/${p.id}`),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watch: (_extId, listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
  }
  return {
    host,
    state,
    sidebar,
    paneChips,
    workspaceChips,
    emit: (type: ExtensionEventType, payload: unknown = {}) => {
      for (const l of listeners) l(type, payload)
    },
    changed: () => {
      for (const w of watchers) w()
    },
  }
}

async function until<T>(read: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const PANES: PaneInfo[] = [
  {
    paneId: 'p-web',
    workspaceId: 'w1',
    kind: 'terminal',
    title: 'zsh',
    running: true,
    blockCount: 0,
    pid: 101,
  },
  {
    paneId: 'p-ssh',
    workspaceId: 'w2',
    kind: 'terminal',
    title: 'zsh',
    running: true,
    blockCount: 0,
    pid: 202,
  },
  {
    paneId: 'p-file',
    workspaceId: 'w1',
    kind: 'editor',
    title: 'a.ts',
    running: false,
    blockCount: 0,
    pid: 303,
  },
]

describe('PortsBoard', () => {
  let board: PortsBoard | null = null
  let trees = new Map<number, TreeInfo>()
  const scanned: number[][] = []
  const scan = async (roots: number[]): Promise<Map<number, TreeInfo>> => {
    scanned.push(roots)
    return trees
  }

  afterEach(() => {
    board?.stop()
    board = null
    scanned.length = 0
  })

  const startBoard = (fake: ReturnType<typeof fakeHost>): PortsBoard => {
    board = new PortsBoard({ host: fake.host, listPanes: async () => PANES, scan, hostPid: 1 })
    board.start()
    return board
  }

  it('shows the ports plug with links, the ssh chip and the ssh sidebar line, scanning only terminals', async () => {
    trees = new Map([
      [101, { ports: [8000, 3000], ssh: null }],
      [202, { ports: [], ssh: { user: 'deploy', host: 'build-box' } }],
    ])
    const fake = fakeHost()
    startBoard(fake)
    expect(await until(() => fake.workspaceChips.get('w1/ports'))).toMatchObject({
      icon: 'plugs',
      text: '2',
      items: [
        { text: ':3000', url: 'http://localhost:3000/' },
        { text: ':8000', url: 'http://localhost:8000/' },
      ],
    })
    expect(fake.paneChips.get('p-ssh/ssh')).toMatchObject({
      text: 'deploy@build-box',
      tone: 'brand',
    })
    expect(fake.sidebar.get('w2/ssh')).toMatchObject({ text: 'build-box', badge: 'SSH' })
    expect(scanned[0]).toEqual([101, 202])
  })

  it('drops the plug when the listener goes away after a command finishes', async () => {
    trees = new Map([[101, { ports: [8000], ssh: null }]])
    const fake = fakeHost()
    startBoard(fake)
    await until(() => fake.workspaceChips.get('w1/ports'))
    trees = new Map([[101, { ports: [], ssh: null }]])
    fake.emit('command.finished', { paneId: 'p-web', workspaceId: 'w1', exitCode: 0 })
    await until(() => (fake.workspaceChips.has('w1/ports') ? undefined : true))
  })

  it('links to 127.0.0.1 when portHost says so', async () => {
    trees = new Map([[101, { ports: [8000], ssh: null }]])
    const fake = fakeHost()
    startBoard(fake)
    await until(() => fake.workspaceChips.get('w1/ports'))
    fake.state.settings = { portHost: '127.0.0.1' }
    fake.changed()
    await until(() => {
      const chip = fake.workspaceChips.get('w1/ports') as { items?: { url: string }[] } | undefined
      return chip?.items?.[0]?.url === 'http://127.0.0.1:8000/' ? true : undefined
    })
  })

  it('publishes nothing while disabled and everything again once re-enabled', async () => {
    trees = new Map([[101, { ports: [8000], ssh: null }]])
    const fake = fakeHost()
    fake.state.enabled = false
    startBoard(fake)
    await new Promise((r) => setTimeout(r, 600))
    expect(fake.state.published).toBe(0)
    expect(scanned).toEqual([])
    fake.state.enabled = true
    fake.changed()
    await until(() => fake.workspaceChips.get('w1/ports'))
  })
})
