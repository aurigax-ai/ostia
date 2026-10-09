import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import type { ExtensionSidebarItem } from '@shared/extensions'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openSidebarUrl, sidebarLines, visibleSidebarItems } from './sidebarItems'

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

describe('sidebarLines', () => {
  it('puts location items on one line and everything else on the live line, in order', () => {
    const lines = sidebarLines([
      item('other', 'count'),
      item('git', 'branch'),
      item('ports', 'ssh'),
    ])
    expect(lines.location.map((i) => i.key)).toEqual(['branch'])
    expect(lines.live.map((i) => i.key)).toEqual(['count', 'ssh'])
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
