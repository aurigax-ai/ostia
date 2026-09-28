import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, TerminalStateSnapshot } from '../shared/types'
import { registerPane } from './idRegistry'
import { type PaneListDeps, listPanes, listSessions } from './paneList'

function ok<R>(result: R): CommandResult<R> {
  return { ok: true, result }
}

describe('paneList.listPanes', () => {
  it('maps each renderer pane to its idRegistry EXTERNAL id and merges in terminal state', async () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-internal-1' })
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([
          { paneId: 'p-internal-1', sessionId: 's1', kind: 'terminal', title: 'zsh', cwd: '/x' },
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
    const deps: PaneListDeps = { execCommand, getTerminalState }

    const panes = await listPanes(deps)

    expect(panes).toEqual([
      {
        paneId: identity.externalId,
        sessionId: 's1',
        kind: 'terminal',
        title: 'zsh',
        cwd: '/x/live',
        running: true,
        blockCount: 5,
        lastExitCode: 0,
      },
    ])
    expect(execCommand).toHaveBeenCalledWith({ sessionId: '', paneId: null }, 'pane.list', {
      allSessions: true,
    })
  })

  it('drops a pane with no registered external id', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([{ paneId: 'never-registered', sessionId: 's1', kind: 'terminal', title: 'zsh' }]),
      )
    const getTerminalState = vi.fn().mockReturnValue(undefined)

    const panes = await listPanes({ execCommand, getTerminalState })

    expect(panes).toEqual([])
  })

  it('falls back to the renderer-reported cwd when there is no terminal-state snapshot yet', async () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-no-state' })
    const execCommand = vi
      .fn()
      .mockResolvedValue(
        ok([
          { paneId: 'p-no-state', sessionId: 's1', kind: 'editor', title: 'untitled', cwd: '/y' },
        ]),
      )
    const getTerminalState = vi.fn().mockReturnValue(undefined)

    const panes = await listPanes({ execCommand, getTerminalState })

    expect(panes).toEqual([
      {
        paneId: identity.externalId,
        sessionId: 's1',
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
    const panes = await listPanes({ execCommand, getTerminalState: vi.fn() })
    expect(panes).toEqual([])
  })
})

describe('paneList.listSessions', () => {
  it('passes the renderer session.list result straight through', async () => {
    const sessions = [
      { sessionId: 's1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
    ]
    const execCommand = vi.fn().mockResolvedValue(ok(sessions))

    const result = await listSessions({ execCommand })

    expect(result).toEqual(sessions)
    expect(execCommand).toHaveBeenCalledWith({ sessionId: '', paneId: null }, 'session.list', {})
  })

  it('maps the active pane to its external id and drops an unknown one', async () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's2', paneId: 'p-active-int' })
    const execCommand = vi.fn().mockResolvedValue(
      ok([
        {
          sessionId: 's2',
          name: 'a',
          kind: 'terminal',
          workDir: '/a',
          activePaneId: 'p-active-int',
        },
        { sessionId: 's3', name: 'b', kind: 'terminal', workDir: '/b', activePaneId: 'p-gone' },
      ]),
    )

    const result = await listSessions({ execCommand })

    expect(result[0].activePaneId).toBe(identity.externalId)
    expect(result[1]).not.toHaveProperty('activePaneId')
  })

  it('returns an empty array when the renderer round-trip fails', async () => {
    const execCommand = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'command-failed', message: 'no window' } })
    expect(await listSessions({ execCommand })).toEqual([])
  })
})
