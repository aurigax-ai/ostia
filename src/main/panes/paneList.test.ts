import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { registerPane } from '../control/idRegistry'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  markSessionConflicts,
  type PaneListDeps,
} from './paneList'

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
      waking: () => false,
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

  it('shows the process status and start outcome of a run pane, as process list does', async () => {
    const run = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-run' })
    const deps: PaneListDeps = {
      execCommand: vi
        .fn()
        .mockResolvedValue(
          ok([{ paneId: 'p-run', workspaceId: 's1', kind: 'terminal', title: 'lead' }]),
        ),
      getTerminalState: () => undefined,
      ptyPid: () => undefined,
      windowIds: ONE_WINDOW,
      waking: () => false,
      processOf: (paneId) =>
        paneId === 'p-run' ? { id: 'proc-1', status: 'exited(1)', start: 'failed' } : undefined,
    }
    const [pane] = await listPanes(deps)
    expect(pane).toMatchObject({
      paneId: run.externalId,
      process: { id: 'proc-1', status: 'exited(1)', start: 'failed' },
    })
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
      waking: () => false,
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
      waking: () => false,
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
      waking: () => false,
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
      waking: () => false,
    })

    expect(panes[0]).toMatchObject({ paneId: asleep.externalId, hibernated: true })
    expect(panes[1].paneId).toBe(awake.externalId)
    expect(panes[1]).not.toHaveProperty('hibernated')
  })

  it('passes awaitingActivation through and reports startError only for a pane without a pid', async () => {
    const waiting = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-waiting' })
    const failed = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-failed' })
    const live = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-live' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          paneId: 'p-waiting',
          workspaceId: 's1',
          kind: 'terminal',
          title: 'claude',
          awaitingActivation: true,
        },
        { paneId: 'p-failed', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
        { paneId: 'p-live', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
      ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: (paneId) => (paneId === 'p-live' ? 42 : undefined),
      windowIds: ONE_WINDOW,
      waking: () => false,
      startError: () => 'spawn failed',
    })

    expect(panes[0]).toMatchObject({
      paneId: waiting.externalId,
      awaitingActivation: true,
      startError: 'spawn failed',
    })
    expect(panes[1]).toMatchObject({ paneId: failed.externalId, startError: 'spawn failed' })
    expect(panes[1]).not.toHaveProperty('awaitingActivation')
    expect(panes[2]).toMatchObject({ paneId: live.externalId, pid: 42 })
    expect(panes[2]).not.toHaveProperty('startError')
  })

  it('marks a woken pane waking: true until main sees its agent start', async () => {
    const woken = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-woken' })
    const other = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-other' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        { paneId: 'p-woken', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
        { paneId: 'p-other', workspaceId: 's1', kind: 'terminal', title: 'zsh' },
      ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: ONE_WINDOW,
      waking: (paneId) => paneId === 'p-woken',
    })

    expect(panes[0]).toMatchObject({ paneId: woken.externalId, waking: true })
    expect(panes[1].paneId).toBe(other.externalId)
    expect(panes[1]).not.toHaveProperty('waking')
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
      waking: () => false,
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

  it('marks panes whose live agents run the same session, across windows', async () => {
    const first = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-dup-1' })
    const second = registerPane({ windowId: 'w2', workspaceId: 's2', paneId: 'p-dup-2' })
    const stale = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-dup-stale' })
    const codex = registerPane({ windowId: 'w2', workspaceId: 's2', paneId: 'p-dup-codex' })
    const pane = (paneId: string, extra: Record<string, unknown>) => ({
      paneId,
      workspaceId: 's1',
      kind: 'terminal',
      title: paneId,
      ...extra,
    })
    const execCommand = vi.fn(async (target: CommandTarget) =>
      target.windowId === '1'
        ? ok([
            pane('p-dup-1', { agent: 'claude', agentSessionId: 'sess-dup' }),
            pane('p-dup-stale', { agentSessionId: 'sess-dup' }),
          ])
        : ok([
            pane('p-dup-2', { agent: 'claude', agentSessionId: 'sess-dup' }),
            pane('p-dup-codex', { agent: 'codex', agentSessionId: 'sess-dup' }),
          ]),
    )

    const panes = await listPanes({
      execCommand,
      getTerminalState: vi.fn(),
      ptyPid: vi.fn(),
      windowIds: () => ['1', '2'],
      waking: () => false,
    })
    const byId = (id: string) => panes.find((p) => p.paneId === id)

    expect(byId(first.externalId)?.agentSessionConflict).toEqual([second.externalId])
    expect(byId(second.externalId)?.agentSessionConflict).toEqual([first.externalId])
    expect(byId(stale.externalId)).not.toHaveProperty('agentSessionConflict')
    expect(byId(codex.externalId)).not.toHaveProperty('agentSessionConflict')
  })

  it('does not mark a lone agent pane or two panes with different sessions', () => {
    const entry = (paneId: string, agentSessionId: string) => ({
      paneId,
      workspaceId: 's1',
      kind: 'terminal',
      title: paneId,
      running: true,
      blockCount: 1,
      agent: 'claude',
      agentSessionId,
    })
    const marked = markSessionConflicts([entry('a', 'one'), entry('b', 'two')])
    expect(marked.every((p) => p.agentSessionConflict === undefined)).toBe(true)
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
      waking: () => false,
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
      waking: () => false,
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
      waking: () => false,
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

  it('marks a sandboxed workspace, and only that one', async () => {
    const workspaces = [
      { workspaceId: 's1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
      { workspaceId: 's2', name: 'box', kind: 'terminal', workDir: '/y', state: 'idle' },
    ]
    const execCommand = vi.fn().mockResolvedValue(ok(workspaces))

    const result = await listWorkspaces({
      execCommand,
      windowIds: ONE_WINDOW,
      isSandboxed: (id) => id === 's2',
    })

    expect(result).toEqual([workspaces[0], { ...workspaces[1], sandboxed: true }])
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
      waking: () => false,
    })

    expect(panes.map((p) => p.workspaceId)).toEqual(['s9'])
  })
})
