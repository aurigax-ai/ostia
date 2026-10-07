import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, TerminalStateSnapshot } from '../shared/types'
import { registerPane } from './idRegistry'
import { type PaneListDeps, listPanes, listWorkspaceGroups, listWorkspaces } from './paneList'

const ONE_WINDOW = (): string[] => ['1']

function ok<R>(result: R): CommandResult<R> {
  return { ok: true, result }
}

describe('paneList.listPanes', () => {
  it('maps each renderer pane to its idRegistry EXTERNAL id and merges in terminal state', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-internal-1' })
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([
          { paneId: 'p-internal-1', workspaceId: 's1', kind: 'terminal', title: 'zsh', cwd: '/x' },
        ]),
      )
    const getTerminalState = vi.fn().mockReturnValue({
      paneId: 'p-internal-1',
      generation: 3,
      cwd: '/x/live',
      running: true,
      blockCount: 5,
      lastExitCode: 0,
    } satisfies TerminalStateSnapshot)
    const deps: PaneListDeps = {
      execCommand,
      getTerminalState,
      ptyPid: () => undefined,
      windowIds: ONE_WINDOW,
    }

    const panes = await listPanes(deps)

    expect(panes).toEqual([
      {
        paneId: identity.externalId,
        workspaceId: 's1',
        kind: 'terminal',
        title: 'zsh',
        cwd: '/x/live',
        running: true,
        blockCount: 5,
        lastExitCode: 0,
      },
    ])
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: '1', workspaceId: '', paneId: null },
      'pane.list',
      {
        allWorkspaces: true,
      },
    )
  })

  it('reports the pty pid for a live terminal pane and never for other kinds', async () => {
    const term = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-pid-term' })
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-pid-editor' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        { paneId: 'p-pid-term', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
        { paneId: 'p-pid-editor', workspaceId: 's1', kind: 'editor', title: 'a.ts' },
      ]),
    )
    const ptyPid = vi.fn().mockReturnValue(4242)

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid,
      windowIds: ONE_WINDOW,
    })

    expect(panes.find((p) => p.paneId === term.externalId)?.pid).toBe(4242)
    expect(panes.find((p) => p.kind === 'editor')).not.toHaveProperty('pid')
    expect(ptyPid).toHaveBeenCalledWith('p-pid-term')
    expect(ptyPid).not.toHaveBeenCalledWith('p-pid-editor')
  })

  it("passes a file view's filePath through so extensions can act on the open file", async () => {
    const editor = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-file-editor' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          paneId: 'p-file-editor',
          workspaceId: 's1',
          kind: 'editor',
          title: 'a.ts',
          filePath: '/work/a.ts',
        },
      ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: ONE_WINDOW,
    })

    expect(panes[0]).toMatchObject({ paneId: editor.externalId, filePath: '/work/a.ts' })
  })

  it('passes the split tab a pane sits in through', async () => {
    const inTab = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-split-member' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          paneId: 'p-split-member',
          workspaceId: 's1',
          kind: 'terminal',
          title: 'api',
          splitTabId: 'split-3',
          splitTabName: 'dev',
        },
      ]),
    )
    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: ONE_WINDOW,
    })
    expect(panes[0]).toMatchObject({
      paneId: inTab.externalId,
      splitTabId: 'split-3',
      splitTabName: 'dev',
    })
  })

  it('marks a hibernated pane hibernated: true and leaves the field off every other pane', async () => {
    const asleep = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-asleep' })
    const awake = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-awake' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          paneId: 'p-asleep',
          workspaceId: 's1',
          kind: 'terminal',
          title: 'claude',
          hibernated: true,
        },
        { paneId: 'p-awake', workspaceId: 's1', kind: 'terminal', title: 'zsh', hibernated: 'yes' },
      ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: ONE_WINDOW,
    })

    expect(panes[0]).toMatchObject({ paneId: asleep.externalId, hibernated: true })
    expect(panes[1].paneId).toBe(awake.externalId)
    expect(panes[1]).not.toHaveProperty('hibernated')
  })

  it("passes an agent pane's kind, session id and state through and drops malformed ones", async () => {
    const agent = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-agent' })
    const shell = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-agent-bad' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          paneId: 'p-agent',
          workspaceId: 's1',
          kind: 'terminal',
          title: 'claude',
          agent: 'claude',
          agentSessionId: 'sess-123',
          agentState: 'waiting',
          agentMessage: 'Allow Bash?',
        },
        {
          paneId: 'p-agent-bad',
          workspaceId: 's1',
          kind: 'terminal',
          title: 'zsh',
          agent: 7,
          agentSessionId: null,
        },
      ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: ONE_WINDOW,
    })

    expect(panes.find((p) => p.paneId === agent.externalId)).toMatchObject({
      agent: 'claude',
      agentSessionId: 'sess-123',
      agentState: 'waiting',
      agentMessage: 'Allow Bash?',
    })
    const plain = panes.find((p) => p.paneId === shell.externalId)
    expect(plain).not.toHaveProperty('agent')
    expect(plain).not.toHaveProperty('agentSessionId')
  })

  it('drops a pane with no registered external id', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([{ paneId: 'never-registered', workspaceId: 's1', kind: 'terminal', title: 'zsh' }]),
      )
    const getTerminalState = vi.fn().mockReturnValue(undefined)

    const panes = await listPanes({
      execCommand,
      getTerminalState,
      ptyPid: () => undefined,
      windowIds: ONE_WINDOW,
    })

    expect(panes).toEqual([])
  })

  it('falls back to the renderer-reported cwd when there is no terminal-state snapshot yet', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-no-state' })
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([
          { paneId: 'p-no-state', workspaceId: 's1', kind: 'editor', title: 'untitled', cwd: '/y' },
        ]),
      )
    const getTerminalState = vi.fn().mockReturnValue(undefined)

    const panes = await listPanes({
      execCommand,
      getTerminalState,
      ptyPid: () => undefined,
      windowIds: ONE_WINDOW,
    })

    expect(panes).toEqual([
      {
        paneId: identity.externalId,
        workspaceId: 's1',
        kind: 'editor',
        title: 'untitled',
        cwd: '/y',
        running: false,
        blockCount: 0,
        lastExitCode: undefined,
      },
    ])
  })

  it('returns an empty array when the renderer round-trip fails', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'command-failed', message: 'no window' } })
    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: () => undefined,
      windowIds: ONE_WINDOW,
    })
    expect(panes).toEqual([])
  })
})

describe('paneList.listWorkspaceGroups', () => {
  it('asks the renderer for its groups and passes them through', async () => {
    const groups = [
      { groupId: 'g1', name: 'api', color: 'blue', collapsed: false, workspaceIds: ['s1', 's2'] },
    ]
    const execCommand = vi.fn().mockResolvedValue(ok(groups))

    expect(await listWorkspaceGroups({ execCommand, windowIds: ONE_WINDOW })).toEqual(groups)
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: '1', workspaceId: '', paneId: null },
      'workspace.groups',
      {},
    )
  })

  it('returns an empty array when the renderer round-trip fails', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'command-failed', message: 'no window' } })
    expect(await listWorkspaceGroups({ execCommand, windowIds: ONE_WINDOW })).toEqual([])
  })
})

describe('paneList.listWorkspaces', () => {
  it('passes the renderer workspace.list result straight through', async () => {
    const workspaces = [
      { workspaceId: 's1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
    ]
    const execCommand = vi.fn().mockResolvedValue(ok(workspaces))

    const result = await listWorkspaces({ execCommand, windowIds: ONE_WINDOW })

    expect(result).toEqual(workspaces)
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: '1', workspaceId: '', paneId: null },
      'workspace.list',
      {},
    )
  })

  it('maps the active pane to its external id and drops an unknown one', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'p-active-int' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          workspaceId: 's2',
          name: 'a',
          kind: 'terminal',
          workDir: '/a',
          activePaneId: 'p-active-int',
        },
        { workspaceId: 's3', name: 'b', kind: 'terminal', workDir: '/b', activePaneId: 'p-gone' },
      ]),
    )

    const result = await listWorkspaces({ execCommand, windowIds: ONE_WINDOW })

    expect(result[0].activePaneId).toBe(identity.externalId)
    expect(result[1]).not.toHaveProperty('activePaneId')
  })

  it('returns an empty array when the renderer round-trip fails', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'command-failed', message: 'no window' } })
    expect(await listWorkspaces({ execCommand, windowIds: ONE_WINDOW })).toEqual([])
  })
})

describe('paneList across windows', () => {
  it('lists the workspaces of every window, main window first', async () => {
    const execCommand = vi.fn(async (target: { windowId?: string }) =>
      ok([{ workspaceId: `ws-${target.windowId}`, name: 'x', kind: 'terminal', workDir: '/x' }]),
    )

    const result = await listWorkspaces({ execCommand, windowIds: () => ['1', '2'] })

    expect(result.map((w) => w.workspaceId)).toEqual(['ws-1', 'ws-2'])
  })

  it('keeps the panes of the windows that answered when one fails', async () => {
    registerPane({ windowId: '2', workspaceId: 's9', paneId: 'p-second-window' })
    const execCommand = vi.fn(async (target: { windowId?: string }) =>
      target.windowId === '1'
        ? { ok: false as const, error: { code: 'command-failed' as const, message: 'gone' } }
        : ok([{ paneId: 'p-second-window', workspaceId: 's9', kind: 'terminal', title: 'zsh' }]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: () => undefined,
      windowIds: () => ['1', '2'],
    })

    expect(panes.map((p) => p.workspaceId)).toEqual(['s9'])
  })
})
