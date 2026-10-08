import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { findPane } from '../layout/tree'
import type { PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import * as blockActions from './blockActions'
import { hibernateIdleAgents, hibernateWorkspace, wakeWorkspace } from './hibernationScheduler'
import { forgetPaneActivity, markPaneActivity } from './paneActivity'

let layoutInit: ReturnType<typeof useLayoutStore.getState>
let blocksInit: ReturnType<typeof useBlocksStore.getState>
let settingsInit: ReturnType<typeof useSettingsStore.getState>
let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

const NOW = 10_000_000
const IDS = ['shown', 'idle-claude', 'fresh-claude', 'no-token', 'npm', 'at-prompt']

beforeAll(() => {
  registerBuiltinCommands()
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
  vi.restoreAllMocks()
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
    vi.mocked(window.ostia.pty.hibernate).mockResolvedValueOnce('no-terminal')
    expect(await hibernateIdleAgents(NOW)).toEqual([])
    expect(hibernated('idle-claude')).toBe(false)
  })

  it('leaves an idle agent with background work running and takes the next idle one', async () => {
    seed(1)
    markPaneActivity('fresh-claude', NOW - 1_800_000)
    vi.mocked(window.ostia.pty.hibernate).mockImplementation(async (paneId) =>
      paneId === 'idle-claude' ? 'subagent' : 'hibernated',
    )
    expect(await hibernateIdleAgents(NOW)).toEqual(['fresh-claude'])
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('fresh-claude')).toBe(true)
  })
})

describe('hibernateWorkspace', () => {
  it('stops every agent with a resume token in the workspace, shown or not, and nothing else', async () => {
    seed(10)
    expect(await hibernateWorkspace('s2')).toEqual({
      hibernated: ['idle-claude', 'fresh-claude'],
      skipped: {},
    })
    expect((await hibernateWorkspace('s1')).hibernated).toEqual(['shown'])
    for (const id of ['no-token', 'npm', 'at-prompt']) expect(hibernated(id)).toBe(false)
  })

  it('skips the agents that still have background work and counts them by reason', async () => {
    seed(10)
    run('at-prompt', 'claude')
    const busy: Record<string, 'subagent' | 'child-process'> = {
      'idle-claude': 'subagent',
      'at-prompt': 'child-process',
    }
    vi.mocked(window.ostia.pty.hibernate).mockImplementation(
      async (paneId) => busy[paneId] ?? 'hibernated',
    )
    expect(await hibernateWorkspace('s2')).toEqual({
      hibernated: ['fresh-claude'],
      skipped: { subagent: 1, 'child-process': 1 },
    })
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('fresh-claude')).toBe(true)
  })

  it('works with automatic hibernation turned off', async () => {
    seed(10)
    useSettingsStore.setState((s) => ({
      agents: { ...s.agents, hibernation: { ...s.agents.hibernation, enabled: false } },
    }))
    expect((await hibernateWorkspace('s1')).hibernated).toEqual(['shown'])
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

describe('the pane.wake command an agent reaches through main', () => {
  const target = (paneId: string) => ({ activeWorkspaceId: 's2', activePaneId: paneId })

  it('wakes a hibernated pane and types only its stored resume command at the first idle prompt', async () => {
    seed(10)
    await hibernateWorkspace('s2')
    const typed = vi.spyOn(blockActions, 'runWhenIdle').mockImplementation(() => () => {})
    expect(await commands.execWith(target('idle-claude'), 'pane.hibernated')).toEqual({
      ok: true,
      result: { hibernated: true },
    })
    expect(await commands.execWith(target('idle-claude'), 'pane.wake')).toEqual({
      ok: true,
      result: { woke: true },
    })
    expect(typed).toHaveBeenCalledTimes(1)
    expect(typed).toHaveBeenCalledWith(
      'idle-claude',
      'claude --resume tok-idle-claude',
      undefined,
      expect.any(Function),
      expect.any(Function),
    )
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('fresh-claude')).toBe(true)
  })

  it('reports the pane as waking to main, and as no longer waking when its resume cannot run', async () => {
    seed(10)
    await hibernateWorkspace('s2')
    const typed = vi.spyOn(blockActions, 'runWhenIdle').mockImplementation(() => () => {})
    const report = vi.mocked(window.ostia.pty.reportWaking)
    report.mockClear()
    await commands.execWith(target('idle-claude'), 'pane.wake')
    expect(report.mock.calls).toEqual([['idle-claude', true]])
    typed.mock.calls[0][4]?.()
    expect(report.mock.calls).toEqual([
      ['idle-claude', true],
      ['idle-claude', false],
    ])
  })

  it('starts the woken shell in the token’s folder and types nothing once that folder is gone', async () => {
    seed(10)
    useLayoutStore
      .getState()
      .setResume('s2', 'idle-claude', { agent: 'claude', id: 'tok-idle-claude', cwd: '/b/tree' })
    await hibernateWorkspace('s2')
    const typed = vi.spyOn(blockActions, 'runWhenIdle').mockImplementation(() => () => {})
    await commands.execWith(target('idle-claude'), 'pane.wake')
    const pane = () =>
      findPane(useLayoutStore.getState().byWorkspace.s2?.root ?? terminal('x'), 'idle-claude')
    expect(pane()?.spawnDir).toBe('/b/tree')
    const allowed = typed.mock.calls[0][3]
    expect(allowed?.()).toBe(true)

    useLayoutStore.getState().settleSpawnDir('s2', 'idle-claude', true)
    expect(pane()?.spawnDir).toBeUndefined()
    expect(pane()?.resumeFolderMissing).toBe('/b/tree')
    expect(allowed?.()).toBe(false)
    expect(await commands.execWith(target('idle-claude'), 'agent.resume')).toEqual({
      ok: true,
      result: { resumed: false },
    })
  })

  it('wakes nothing and types nothing for a pane that is not hibernated', async () => {
    seed(10)
    const typed = vi.spyOn(blockActions, 'runWhenIdle').mockImplementation(() => () => {})
    expect(await commands.execWith(target('npm'), 'pane.hibernated')).toEqual({
      ok: true,
      result: { hibernated: false },
    })
    expect(await commands.execWith(target('npm'), 'pane.wake')).toEqual({
      ok: true,
      result: { woke: false },
    })
    expect(typed).not.toHaveBeenCalled()
    expect(window.ostia.pty.reportWaking).not.toHaveBeenCalledWith('npm', true)
  })
})
