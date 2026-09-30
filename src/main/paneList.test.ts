import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, TerminalStateSnapshot } from '../shared/types'
import { registerPane } from './idRegistry'
import { type PaneListDeps, listPanes, listWorkspaces } from './paneList'

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
    const deps: PaneListDeps = { execCommand, getTerminalState, ptyPid: () => undefined }

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
    expect(execCommand).toHaveBeenCalledWith({ workspaceId: '', paneId: null }, 'pane.list', {
      allWorkspaces: true,
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

    const panes = await listPanes({ execCommand, getTerminalState: vi.fn(), ptyPid })

    expect(panes.find((p) => p.paneId === term.externalId)?.pid).toBe(4242)
    expect(panes.find((p) => p.kind === 'editor')).not.toHaveProperty('pid')
    expect(ptyPid).toHaveBeenCalledWith('p-pid-term')
    expect(ptyPid).not.toHaveBeenCalledWith('p-pid-editor')
  })

  it('drops a pane with no registered external id', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([{ paneId: 'never-registered', workspaceId: 's1', kind: 'terminal', title: 'zsh' }]),
      )
    const getTerminalState = vi.fn().mockReturnValue(undefined)

    const panes = await listPanes({ execCommand, getTerminalState, ptyPid: () => undefined })

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

    const panes = await listPanes({ execCommand, getTerminalState, ptyPid: () => undefined })

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
    })
    expect(panes).toEqual([])
  })
})

describe('paneList.listWorkspaces', () => {
  it('passes the renderer workspace.list result straight through', async () => {
    const workspaces = [
      { workspaceId: 's1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
    ]
    const execCommand = vi.fn().mockResolvedValue(ok(workspaces))

    const result = await listWorkspaces({ execCommand })

    expect(result).toEqual(workspaces)
    expect(execCommand).toHaveBeenCalledWith(
      { workspaceId: '', paneId: null },
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

    const result = await listWorkspaces({ execCommand })

    expect(result[0].activePaneId).toBe(identity.externalId)
    expect(result[1]).not.toHaveProperty('activePaneId')
  })

  it('returns an empty array when the renderer round-trip fails', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'command-failed', message: 'no window' } })
    expect(await listWorkspaces({ execCommand })).toEqual([])
  })
})
