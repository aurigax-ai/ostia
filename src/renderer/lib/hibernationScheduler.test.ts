import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { hibernateIdleAgents } from './hibernationScheduler'
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
  vi.mocked(window.pine.pty.hibernate).mockClear()
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
    agents: { hibernation: { enabled: true, idleSeconds: 600, maxLiveTerminals } },
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
    expect(window.pine.pty.hibernate).toHaveBeenCalledTimes(1)
    expect(window.pine.pty.hibernate).toHaveBeenCalledWith('idle-claude')
    expect(hibernated('idle-claude')).toBe(true)
    for (const id of ['shown', 'fresh-claude', 'npm', 'at-prompt'])
      expect(hibernated(id)).toBe(false)
  })

  it('does nothing while live agents fit under the limit', async () => {
    seed(3)
    expect(await hibernateIdleAgents(NOW)).toEqual([])
    expect(window.pine.pty.hibernate).not.toHaveBeenCalled()
  })

  it('does nothing when hibernation is off', async () => {
    seed(0)
    useSettingsStore.setState({
      agents: { hibernation: { enabled: false, idleSeconds: 600, maxLiveTerminals: 0 } },
    })
    expect(await hibernateIdleAgents(NOW)).toEqual([])
  })

  it('leaves the pane live when main had no pty to stop', async () => {
    seed(1)
    vi.mocked(window.pine.pty.hibernate).mockResolvedValueOnce(false)
    expect(await hibernateIdleAgents(NOW)).toEqual([])
    expect(hibernated('idle-claude')).toBe(false)
  })
})
