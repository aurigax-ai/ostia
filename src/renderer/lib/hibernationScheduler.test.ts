import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { findPane } from '../layout/tree'
import type { LayoutNode, PaneNode } from '../layout/types'
import { useBlocksStore } from '../stores/blocksStore'
import { useHibernateSkippedStore } from '../stores/hibernateSkippedStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import * as blockActions from './blockActions'
import {
  WAKE_WAVE_SIZE,
  hibernateIdleAgents,
  hibernateWorkspaces,
  resumeWorkspaces,
} from './hibernationScheduler'
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

const heldResumes: Array<{ typed: () => void; gaveUp: () => void }> = []

function holdResumes() {
  return vi
    .spyOn(blockActions, 'runWhenIdle')
    .mockImplementation((_paneId, _command, _timeoutMs, _allowed, onGiveUp, onTyped) => {
      heldResumes.push({ typed: onTyped ?? (() => {}), gaveUp: onGiveUp ?? (() => {}) })
      return () => {}
    })
}

afterEach(() => {
  while (heldResumes.length > 0) heldResumes.shift()?.typed()
  useLayoutStore.setState(layoutInit, true)
  useBlocksStore.setState(blocksInit, true)
  useSettingsStore.setState(settingsInit, true)
  useWorkspacesStore.setState(workspacesInit, true)
  useHibernateSkippedStore.setState({ skipped: null })
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

describe('hibernateWorkspaces', () => {
  it('stops every agent with a resume token in the workspace, shown or not, and nothing else', async () => {
    seed(10)
    expect(await hibernateWorkspaces(['s2'])).toEqual({
      hibernated: ['idle-claude', 'fresh-claude'],
      skipped: {},
    })
    expect((await hibernateWorkspaces(['s1'])).hibernated).toEqual(['shown'])
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
    expect(await hibernateWorkspaces(['s2'])).toEqual({
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
    expect((await hibernateWorkspaces(['s1'])).hibernated).toEqual(['shown'])
  })

  it('wakes only the panes it put to sleep in that workspace', async () => {
    seed(10)
    await hibernateWorkspaces(['s2'])
    await hibernateWorkspaces(['s1'])
    holdResumes()
    expect(resumeWorkspaces(['s2'])).toEqual(['idle-claude', 'fresh-claude'])
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('shown')).toBe(true)
  })
})

const agentPane = (id: string): PaneNode => terminal(id)

function row(...panes: PaneNode[]) {
  const root: LayoutNode =
    panes.length === 1
      ? panes[0]
      : {
          type: 'split',
          id: `split-${panes[0].id}`,
          direction: 'horizontal',
          sizes: panes.map(() => 1),
          children: panes,
        }
  return { root, activePaneId: panes[0].id, zoomedPaneId: null }
}

const GROUP_AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5']

function seedGroups(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'g1', name: 'api', kind: 'terminal', workDir: '/api', state: 'idle', groupId: 'build' },
      { id: 'solo', name: 'solo', kind: 'terminal', workDir: '/solo', state: 'idle' },
      { id: 'g2', name: 'web', kind: 'terminal', workDir: '/web', state: 'idle', groupId: 'build' },
      { id: 'o1', name: 'ops', kind: 'terminal', workDir: '/ops', state: 'idle', groupId: 'ops' },
    ],
    groups: [
      { id: 'build', name: 'build' },
      { id: 'ops', name: 'ops' },
    ],
    activeWorkspaceId: 'g1',
  })
  useLayoutStore.setState({
    byWorkspace: {
      g1: row(agentPane('a1'), agentPane('a2'), terminal('g-shell', false)),
      g2: row(agentPane('a3'), agentPane('a4'), agentPane('a5'), agentPane('g-npm')),
      solo: row(agentPane('solo-agent'), agentPane('solo-prompt')),
      o1: row(agentPane('ops-agent')),
    },
  })
  for (const id of [...GROUP_AGENTS, 'solo-agent', 'ops-agent']) run(id, 'claude')
  run('g-shell', 'claude')
  run('g-npm', 'npm test')
  useBlocksStore.getState().promptStart('solo-prompt', { line: 0 }, null)
}

const at = (workspaceId: string) => ({ activeWorkspaceId: workspaceId, activePaneId: null })

describe('hibernating and resuming agents in bulk', () => {
  it('hibernates the agents of every workspace of a group, and none outside it', async () => {
    seedGroups()
    expect(await hibernateWorkspaces(['g1', 'g2'])).toEqual({
      hibernated: GROUP_AGENTS,
      skipped: {},
    })
    for (const id of ['g-shell', 'g-npm', 'solo-agent', 'solo-prompt', 'ops-agent'])
      expect(hibernated(id)).toBe(false)
    expect(vi.mocked(window.ostia.pty.hibernate).mock.calls.map(([id]) => id)).toEqual(GROUP_AGENTS)
  })

  it('leaves the agents of a group that still have background work running, and counts them by reason', async () => {
    seedGroups()
    const busy: Record<string, 'subagent' | 'child-process'> = {
      a2: 'subagent',
      a3: 'child-process',
      a5: 'child-process',
    }
    vi.mocked(window.ostia.pty.hibernate).mockImplementation(
      async (paneId) => busy[paneId] ?? 'hibernated',
    )
    expect(await hibernateWorkspaces(['g1', 'g2'])).toEqual({
      hibernated: ['a1', 'a4'],
      skipped: { subagent: 1, 'child-process': 2 },
    })
    for (const id of Object.keys(busy)) expect(hibernated(id)).toBe(false)
  })

  it('from the palette says which agents of the group it left running', async () => {
    seedGroups()
    vi.mocked(window.ostia.pty.hibernate).mockImplementation(async (paneId) =>
      paneId === 'a4' ? 'background-task' : 'hibernated',
    )
    expect(await commands.execWith(at('g1'), 'workspace.hibernateGroupAgents')).toEqual({
      ok: true,
      result: { hibernated: ['a1', 'a2', 'a3', 'a5'] },
    })
    expect(useHibernateSkippedStore.getState().skipped).toEqual({ 'background-task': 1 })
  })

  it('in an ungrouped workspace takes the running agent and leaves the pane at a prompt', async () => {
    seedGroups()
    expect((await hibernateWorkspaces(['solo'])).hibernated).toEqual(['solo-agent'])
    expect(hibernated('solo-prompt')).toBe(false)
    expect(hibernated('a1')).toBe(false)
  })

  it('resumes a group a few panes at a time, each typing only its own resume command', async () => {
    seedGroups()
    await hibernateWorkspaces(['g1', 'g2', 'o1'])
    const typed = holdResumes()
    expect(resumeWorkspaces(['g1', 'g2'])).toEqual(GROUP_AGENTS)
    expect(WAKE_WAVE_SIZE).toBe(3)
    expect(typed.mock.calls.map(([id, command]) => [id, command])).toEqual([
      ['a1', 'claude --resume tok-a1'],
      ['a2', 'claude --resume tok-a2'],
      ['a3', 'claude --resume tok-a3'],
    ])
    expect(GROUP_AGENTS.map(hibernated)).toEqual([false, false, false, true, true])

    heldResumes.shift()?.typed()
    expect(typed.mock.calls.map(([id]) => id)).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(hibernated('a5')).toBe(true)

    heldResumes.shift()?.gaveUp()
    expect(typed.mock.calls.map(([id, command]) => [id, command])[4]).toEqual([
      'a5',
      'claude --resume tok-a5',
    ])
    expect(typed).toHaveBeenCalledTimes(5)
    expect(GROUP_AGENTS.some(hibernated)).toBe(false)
    expect(hibernated('ops-agent')).toBe(true)
  })

  it('reports every woken pane as waking, and no pane before its turn', async () => {
    seedGroups()
    await hibernateWorkspaces(['g1', 'g2'])
    holdResumes()
    const report = vi.mocked(window.ostia.pty.reportWaking)
    report.mockClear()
    resumeWorkspaces(['g1', 'g2'])
    expect(report.mock.calls).toEqual([
      ['a1', true],
      ['a2', true],
      ['a3', true],
    ])
    heldResumes.shift()?.gaveUp()
    expect(report.mock.calls.slice(3)).toEqual([
      ['a1', false],
      ['a4', true],
    ])
  })

  it('asked twice, wakes each pane once and keeps the wave size', async () => {
    seedGroups()
    await hibernateWorkspaces(['g1', 'g2'])
    const typed = holdResumes()
    resumeWorkspaces(['g1', 'g2'])
    expect(resumeWorkspaces(['g1', 'g2'])).toEqual([])
    expect(typed).toHaveBeenCalledTimes(3)
    while (heldResumes.length > 0) heldResumes.shift()?.typed()
    expect(typed.mock.calls.map(([id]) => id)).toEqual(GROUP_AGENTS)
  })

  it('skips a hibernated pane whose folder is gone and a queued pane that was closed', async () => {
    seedGroups()
    await hibernateWorkspaces(['g1', 'g2'])
    useLayoutStore.setState((s) => ({
      byWorkspace: {
        ...s.byWorkspace,
        g1: row(
          { ...agentPane('a1'), hibernated: true, resumeFolderMissing: '/api/tree' },
          { ...agentPane('a2'), hibernated: true },
        ),
      },
    }))
    const typed = holdResumes()
    expect(resumeWorkspaces(['g1', 'g2'])).toEqual(['a2', 'a3', 'a4', 'a5'])
    expect(hibernated('a1')).toBe(true)
    useLayoutStore.getState().closePane('g2', 'a5')
    while (heldResumes.length > 0) heldResumes.shift()?.typed()
    expect(typed.mock.calls.map(([id]) => id)).toEqual(['a2', 'a3', 'a4'])
  })

  it('runs from the palette for the target workspace or its whole group, never for a socket caller', async () => {
    seedGroups()
    for (const id of [
      'workspace.hibernateAgents',
      'workspace.resumeAgents',
      'workspace.hibernateGroupAgents',
      'workspace.resumeGroupAgents',
    ]) {
      expect(commands.isLocal(id)).toBe(true)
      expect(commands.describe().some((c) => c.id === id)).toBe(false)
    }
    expect(await commands.execWith(at('g2'), 'workspace.hibernateAgents')).toEqual({
      ok: true,
      result: { hibernated: ['a3', 'a4', 'a5'] },
    })
    expect(await commands.execWith(at('g2'), 'workspace.hibernateGroupAgents')).toEqual({
      ok: true,
      result: { hibernated: ['a1', 'a2'] },
    })
    expect(await commands.execWith(at('solo'), 'workspace.hibernateGroupAgents')).toEqual({
      ok: true,
      result: { hibernated: [] },
    })
    expect(hibernated('solo-agent')).toBe(false)

    holdResumes()
    expect(await commands.execWith(at('solo'), 'workspace.resumeGroupAgents')).toEqual({
      ok: true,
      result: { resumed: [] },
    })
    expect(await commands.execWith(at('g1'), 'workspace.resumeAgents')).toEqual({
      ok: true,
      result: { resumed: ['a1', 'a2'] },
    })
    expect(await commands.execWith(at('g1'), 'workspace.resumeGroupAgents')).toEqual({
      ok: true,
      result: { resumed: ['a3', 'a4', 'a5'] },
    })
    expect(hibernated('ops-agent')).toBe(false)
  })
})

describe('the pane.wake command an agent reaches through main', () => {
  const target = (paneId: string) => ({ activeWorkspaceId: 's2', activePaneId: paneId })

  it('wakes a hibernated pane and types only its stored resume command at the first idle prompt', async () => {
    seed(10)
    await hibernateWorkspaces(['s2'])
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
      expect.any(Function),
    )
    expect(hibernated('idle-claude')).toBe(false)
    expect(hibernated('fresh-claude')).toBe(true)
  })

  it('reports the pane as waking to main, and as no longer waking when its resume cannot run', async () => {
    seed(10)
    await hibernateWorkspaces(['s2'])
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
    await hibernateWorkspaces(['s2'])
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
