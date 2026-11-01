import type { ExtensionSidebarItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { openSidebarUrl, rowItems, visibleSidebarItems } from './sidebarItems'

const item = (extId: string, key: string, workspaceId = 's1'): ExtensionSidebarItem => ({
  extId,
  key,
  workspaceId,
  text: key,
  tone: 'neutral',
  kind: extId === 'git' ? 'location' : 'live',
})

const items = [item('git', 'branch'), item('ports', 'ssh'), item('git', 'branch', 's2')]

describe('visibleSidebarItems', () => {
  it('keeps the items of the row’s own workspace', () => {
    expect(visibleSidebarItems(items, 's1', { showSSH: true }).map((i) => i.key)).toEqual([
      'branch',
      'ssh',
    ])
  })

  it('hides the ssh host by its toggle, never another extension’s item', () => {
    expect(visibleSidebarItems(items, 's1', { showSSH: false }).map((i) => i.key)).toEqual([
      'branch',
    ])
    expect(visibleSidebarItems([item('other', 'ssh')], 's1', { showSSH: false })).toHaveLength(1)
  })
})

describe('rowItems', () => {
  it('puts location chips first, then the rest, in order', () => {
    const { chips } = rowItems([
      item('other', 'count'),
      item('git', 'branch'),
      item('ports', 'ssh'),
    ])
    expect(chips.map((i) => i.key)).toEqual(['branch', 'count', 'ssh'])
  })

  it('turns an offline remote into the live line and drops an online one', () => {
    const remote = (tone: ExtensionSidebarItem['tone'], text: string): ExtensionSidebarItem => ({
      ...item('ssh', 'remote'),
      tone,
      text,
    })
    const offline = rowItems([remote('warn', 'Offline · 3 min ago'), item('git', 'branch')])
    expect(offline.offline).toBe('Offline · 3 min ago')
    expect(offline.chips.map((i) => i.key)).toEqual(['branch'])
    const online = rowItems([remote('ok', 'Online')])
    expect(online).toEqual({ offline: null, chips: [] })
  })
})

describe('openSidebarUrl', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
  })

  it('switches to the item’s workspace and opens the url in a browser pane there', () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' },
        { id: 's2', name: 'b', kind: 'terminal', workDir: '/b', state: 'idle' },
      ],
      activeWorkspaceId: 's1',
    })
    openSidebarUrl('s2', 'http://localhost:5173/', 'human')
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe('s2')
    expect(useLayoutStore.getState().byWorkspace.s2?.root).toMatchObject({
      kind: 'browser',
      url: 'http://localhost:5173/',
    })
  })
})
