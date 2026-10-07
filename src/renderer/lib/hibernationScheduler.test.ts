import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { hibernateIdleAgents, hibernateWorkspace, wakeWorkspace } from './hibernationScheduler'
import { forgetPaneActivity, markPaneActivity } from './paneActivity'

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let blocksInit: ReturnType<typeof useBlocksStore.getState>
let settingsInit: ReturnType<typeof useSettingsStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

const NOW = 10_000_000
const IDS = ['shown', 'idle-claude', 'fresh-claude', 'no-token', 'npm', 'at-prompt']

beforeAll(() => {
  layoutInit = useLayoutStore.getState()
  blocksInit = useBlocksStore.getState()
  settingsInit = useSettingsStore.getState()
  workspacesInit = useWorkspacesStore.getState()
})

afterEach(() => {
  useLayoutStore.setState(layoutInit, true)
  useBlocksStore.setState(blocksInit, true)
  useSettingsStore.setState(settingsInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  for (const id of IDS) forgetPaneActivity(id)
  vi.mocked(window.ostia.pty.hibernate).mockClear()
})

const terminal = (id: string, resume = true): PaneNode => ({
  type: 'pane',
  id,
  title: id,
  kind: 'terminal',
  ...(resume ? { resume: { agent: 'claude' as const, id: `tok-${id}` } } : {}),
})

function run(paneId: string, command: string): void {
  const blocks = useBlocksStore.getState()
  blocks.promptStart(paneId, { line: 0 }, null)
  blocks.commandStart(paneId, { line: 1 }, command)
}

function seed(maxLiveTerminals: number): void {
  useSettingsStore.setState({
    agents: {
      hibernation: { enabled: true, idleSeconds: 600, maxLiveTerminals },
      autoResume: false,
      autoSendReferences: true,
      hooks: { claude: true, codex: true },
    },
  })
  useWorkspacesStore.setState({
    workspaces: [
      { id: 's1', name: 'a', kind: 'terminal', workDir: '/a', state: 'idle' },
      { id: 's2', name: 'b', kind: 'terminal', workDir: '/b', state: 'idle' },
    ],
    activeWorkspaceId: 's1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      s1: { root: terminal('shown'), activePaneId: 'shown', zoomedPaneId: null },
      s2: {
        root: {
          type: 'split',
          id: 'split',
          direction: 'horizontal',
          sizes: [1, 1, 1, 1, 1],
          children: [
            terminal('idle-claude'),
            terminal('fresh-claude'),
            terminal('no-token', false),
            terminal('npm'),
            terminal('at-prompt'),
          ],
        },
        activePaneId: 'idle-claude',
        zoomedPaneId: null,
      },
    },
  })
  for (const id of ['shown', 'idle-claude', 'no-token', 'npm', 'at-prompt']) {
    markPaneActivity(id, NOW - 3_600_000)
  }
  markPaneActivity('fresh-claude', NOW - 1000)
  run('shown', 'claude')
  run('idle-claude', 'claude')
  run('fresh-claude', 'claude --resume tok-fresh-claude')
  run('no-token', 'claude')
  run('npm', 'npm test')
  useBlocksStore.getState().promptStart('at-prompt', { line: 0 }, null)
}

const hibernated = (id: string): boolean =>
  Object.values(useLayoutStore.getState().byWorkspace).some(
    (l) => l !== undefined && findPane(l.root, id)?.hibernated === true,
  )

describe('hibernateIdleAgents', () => {
  it('stops only an idle, hidden agent that stored a resume token', async () => {
    seed(1)
    const done = await hibernateIdleAgents(NOW)
    expect(done).toEqual(['idle-claude'])
    expect(window.ostia.pty.hibernate).toHaveBeenCalledTimes(1)
    expect(window.ostia.pty.hibernate).toHaveBeenCalledWith('idle-claude')
    expect(hibernated('idle-claude')).toBe(true)
    for (const id of ['shown', 'fresh-claude', 'npm', 'at-prompt'])
      expect(hibernated(id)).toBe(false)
  })

  it('does nothing while live agents fit under the limit', async () => {
    seed(3)
    expect(await hibernateIdleAgents(NOW)).toEqual([])
    expect(window.ostia.pty.hibernate).not.toHaveBeenCalled()
  })

  it('does nothing when hibernation is off', async () => {
    seed(0)
    useSettingsStore.setState({
      agents: {
        hibernation: { enabled: false, idleSeconds: 600, maxLiveTerminals: 0 },
        autoResume: false,
        autoSendReferences: true,
        hooks: { claude: true, codex: true },
      },
    })
    expect(await hibernateIdleAgents(NOW)).toEqual([])
  })

  it('leaves the pane live when main had no pty to stop', async () => {
    seed(1)
    vi.mocked(window.ostia.pty.hibernate).mockResolvedValueOnce(false)
    expect(await hibernateIdleAgents(NOW)).toEqual([])
    expect(hibernated('idle-claude')).toBe(false)
  })
})

describe('hibernateWorkspace', () => {
  it('stops every agent with a resume token in the workspace, shown or not, and nothing else', async () => {
    seed(10)
    expect(await hibernateWorkspace('s2')).toEqual(['idle-claude', 'fresh-claude'])
    expect(await hibernateWorkspace('s1')).toEqual(['shown'])
    for (const id of ['no-token', 'npm', 'at-prompt']) expect(hibernated(id)).toBe(false)
  })

  it('works with automatic hibernation turned off', async () => {
    seed(10)
    useSettingsStore.setState((s) => ({
      agents: { ...s.agents, hibernation: { ...s.agents.hibernation, enabled: false } },
    }))
    expect(await hibernateWorkspace('s1')).toEqual(['shown'])
  })

  it('wakes only the panes it put to sleep in that workspace', async () => {
    seed(10)
    await hibernateWorkspace('s2')
    await hibernateWorkspace('s1')
    expect(wakeWorkspace('s2')).toEqual(['idle-claude', 'fresh-claude'])
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('shown')).toBe(true)
  })
})
