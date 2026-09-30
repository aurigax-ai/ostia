import type { ExtensionSidebarItem } from '@shared/extensions'
import type { NotificationEntry } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { LayoutNode } from '../layout/types'
import type { Workspace } from '../stores/workspacesStore'
import { VIEW_NOTIFICATIONS_MAX, type ViewDataInputs, buildViewScope } from './viewData'

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  kind: 'terminal',
  workDir: `/home/u/${name}`,
  state: 'idle',
  ...extra,
})

const root: LayoutNode = {
  type: 'split',
  id: 's1',
  direction: 'horizontal',
  sizes: [1, 1],
  children: [
    { type: 'pane', id: 'p1', title: 'zsh', kind: 'terminal' },
    { type: 'pane', id: 'p2', title: 'docs', kind: 'browser', url: 'https://x' },
  ],
}

const sidebar: ExtensionSidebarItem[] = [
  {
    extId: 'ports',
    key: 'port:5173',
    workspaceId: 'w1',
    text: ':5173',
    tone: 'neutral',
    url: 'http://localhost:5173/',
  },
  {
    extId: 'ports',
    key: 'port:3000',
    workspaceId: 'w2',
    text: ':3000',
    tone: 'neutral',
    url: 'http://localhost:3000/',
  },
  { extId: 'ports', key: 'ssh', workspaceId: 'w1', text: 'me@box', tone: 'neutral' },
  { extId: 'git', key: 'branch', workspaceId: 'w1', text: 'main +2', tone: 'neutral' },
  { extId: 'other', key: 'port:1', workspaceId: 'w1', text: 'not a port', tone: 'neutral' },
]

function inputs(extra: Partial<ViewDataInputs> = {}): ViewDataInputs {
  return {
    workspaces: [ws('w1', 'pine', { projectDir: '~/pine', state: 'waiting' }), ws('w2', 'site')],
    activeWorkspaceId: 'w1',
    byWorkspace: { w1: { root, activePaneId: 'p2', zoomedPaneId: null } },
    attention: {
      p1: { state: 'waiting', unread: true, message: 'needs input', at: 1 },
    },
    sidebar,
    approvals: 2,
    notifications: [],
    agentOf: (paneId) => (paneId === 'p1' ? 'claude' : null),
    now: 1_000,
    ...extra,
  }
}

describe('buildViewScope', () => {
  it('describes every workspace with unread count, git summary and ports', () => {
    const scope = buildViewScope(inputs(), ['workspaces', 'workspace'])
    expect(scope.workspaces).toEqual([
      {
        id: 'w1',
        index: 0,
        name: 'pine',
        project: { name: 'pine', path: '~/pine' },
        dir: '/home/u/pine',
        description: null,
        state: 'waiting',
        unread: 1,
        active: true,
        pinned: false,
        panes: 2,
        git: 'main +2',
        ports: [{ port: 5173, url: 'http://localhost:5173/' }],
      },
      expect.objectContaining({
        id: 'w2',
        index: 1,
        unread: 0,
        active: false,
        panes: 0,
        git: null,
      }),
    ])
    expect(scope.workspace).toEqual((scope.workspaces as unknown[])[0])
  })

  it('lists the panes of the current workspace with their agent and attention', () => {
    expect(buildViewScope(inputs(), ['panes']).panes).toEqual([
      {
        id: 'p1',
        title: 'zsh',
        kind: 'terminal',
        agent: 'claude',
        attention: 'waiting',
        unread: true,
        message: 'needs input',
        active: false,
      },
      {
        id: 'p2',
        title: 'docs',
        kind: 'browser',
        agent: null,
        attention: 'none',
        unread: false,
        message: null,
        active: true,
      },
    ])
  })

  it('has no current workspace or panes when none is open', () => {
    const scope = buildViewScope(inputs({ activeWorkspaceId: null }), ['workspace', 'panes'])
    expect(scope.workspace).toBeNull()
    expect(scope.panes).toEqual([])
  })

  it('gathers listening ports from the ports extension only, sorted', () => {
    expect(buildViewScope(inputs(), ['ports']).ports).toEqual([
      { port: 3000, url: 'http://localhost:3000/', workspace: 'site', workspaceId: 'w2' },
      { port: 5173, url: 'http://localhost:5173/', workspace: 'pine', workspaceId: 'w1' },
    ])
  })

  it('puts the newest notifications first and caps them', () => {
    const notifications: NotificationEntry[] = Array.from({ length: 60 }, (_, i) => ({
      id: `n${i}`,
      ts: new Date(i * 1000).toISOString(),
      kind: 'message',
      title: `note ${i}`,
      from: 'pane',
    }))
    const list = buildViewScope(inputs({ notifications }), ['notifications']).notifications as {
      title: string
      at: number
    }[]
    expect(list).toHaveLength(VIEW_NOTIFICATIONS_MAX)
    expect(list[0]).toMatchObject({ title: 'note 59', at: 59_000 })
  })

  it('includes only the sources a view asks for', () => {
    expect(Object.keys(buildViewScope(inputs(), ['approvals', 'clock']))).toEqual([
      'approvals',
      'clock',
    ])
    expect(buildViewScope(inputs(), ['approvals', 'clock'])).toEqual({
      approvals: { pending: 2 },
      clock: { now: 1_000 },
    })
  })
})
