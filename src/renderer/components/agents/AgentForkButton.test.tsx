import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allPanes, createPane, findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import * as blockActions from '@/lib/terminal/blockActions'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useTabSleepNoticeStore } from '@/stores/workspaces/tabSleepNoticeStore'
import { AgentForkButton } from './AgentForkButton'

const FORK = 'Fork conversation into a new tab'

function hookAgent(command: string): 'claude' | 'codex' | null {
  const program = command.split(' ')[0]?.replaceAll("'", '')
  return program === 'claude' || program === 'codex' ? program : null
}

function runCommand(paneId: string, command: string): void {
  useBlocksStore.getState().commandStart(paneId, { line: 1 }, command)
  const agent = hookAgent(command)
  if (agent) useBlocksStore.getState().markAgent(paneId, agent)
}

function seed(pane: PaneNode): void {
  useLayoutStore.setState({
    byWorkspace: { s1: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
  })
}

function panes(): PaneNode[] {
  return allPanes(useLayoutStore.getState().byWorkspace.s1.root)
}

describe('AgentForkButton', () => {
  const blocks = useBlocksStore.getState()
  const layouts = useLayoutStore.getState()
  const notices = useTabSleepNoticeStore.getState()
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useBlocksStore.setState(blocks, true)
    useLayoutStore.setState(layouts, true)
    useTabSleepNoticeStore.setState(notices, true)
  })

  it('shows nothing for an agent that reported no session, a plain shell or an agent that ended', () => {
    const noToken = createPane('terminal')
    runCommand(noToken.id, 'claude')
    const shell = { ...createPane('terminal'), resume: { agent: 'claude' as const, id: 'abc' } }
    runCommand(shell.id, 'pnpm test')
    const ended = { ...createPane('terminal'), resume: { agent: 'codex' as const, id: 'abc' } }
    for (const pane of [noToken, shell, ended]) {
      const { container, unmount } = render(<AgentForkButton pane={pane} workspaceId="s1" />)
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })

  it('opens one new tab for the fork, in the agent’s folder, and types nothing into the original', () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const insert = vi.spyOn(blockActions, 'insertCommand')
    const pane = {
      ...createPane('terminal', 'Refactor parser', '/home/u'),
      resume: {
        agent: 'claude' as const,
        id: 'abc-123',
        cwd: '/home/u/proj',
        args: ['--model', 'opus'],
      },
    }
    seed(pane)
    runCommand(pane.id, 'claude')
    render(<AgentForkButton pane={pane} workspaceId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: FORK }))

    expect(panes()).toHaveLength(2)
    const fork = panes().find((p) => p.id !== pane.id)
    expect(fork).toMatchObject({
      kind: 'terminal',
      title: 'Fork of Refactor parser',
      spawnDir: '/home/u/proj',
    })
    expect(fork?.resume).toBeUndefined()
    expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(fork?.id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      fork?.id,
      "'claude' --resume abc-123 --fork-session --model opus",
    ])
    expect(insert).not.toHaveBeenCalled()
    expect(findPane(useLayoutStore.getState().byWorkspace.s1.root, pane.id)).toEqual(pane)
  })

  it('forks a Codex session with its own fork form', () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const pane = { ...createPane('terminal'), resume: { agent: 'codex' as const, id: 'tok' } }
    seed(pane)
    runCommand(pane.id, 'codex')
    render(<AgentForkButton pane={pane} workspaceId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: FORK }))

    expect(run.mock.calls[0][1]).toBe("'codex' fork tok")
  })

  it('forks a hibernated agent without waking it', () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const pane = {
      ...createPane('terminal'),
      hibernated: true as const,
      resume: { agent: 'claude' as const, id: 'tok', cwd: '/home/u/proj' },
    }
    seed(pane)
    render(<AgentForkButton pane={pane} workspaceId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: FORK }))

    expect(run.mock.calls[0][1]).toBe("'claude' --resume tok --fork-session")
    expect(findPane(useLayoutStore.getState().byWorkspace.s1.root, pane.id)).toEqual(pane)
  })

  it('refuses with a notice and opens nothing when the agent’s folder is known to be gone', () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle')
    const pane = {
      ...createPane('terminal'),
      hibernated: true as const,
      resumeFolderMissing: '/home/u/gone',
      resume: { agent: 'claude' as const, id: 'tok', cwd: '/home/u/gone' },
    }
    seed(pane)
    render(<AgentForkButton pane={pane} workspaceId="s1" />)

    fireEvent.click(screen.getByRole('button', { name: FORK }))

    expect(panes()).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()
    expect(useTabSleepNoticeStore.getState().notice).toEqual({
      kind: 'forkFolderMissing',
      agent: 'claude',
      path: '/home/u/gone',
    })
  })

  it('closes the new tab and says so when the folder turns out missing at spawn', () => {
    const run = vi.spyOn(blockActions, 'runWhenIdle').mockReturnValue(() => {})
    const pane = {
      ...createPane('terminal'),
      resume: { agent: 'claude' as const, id: 'tok', cwd: '/home/u/gone' },
    }
    seed(pane)
    runCommand(pane.id, 'claude')
    render(<AgentForkButton pane={pane} workspaceId="s1" />)
    fireEvent.click(screen.getByRole('button', { name: FORK }))
    const forkId = run.mock.calls[0][0]
    const [, , , allowed, onGiveUp] = run.mock.calls[0]

    useLayoutStore.getState().settleSpawnDir('s1', forkId, true)
    expect(allowed?.()).toBe(false)
    onGiveUp?.()

    expect(panes().map((p) => p.id)).toEqual([pane.id])
    expect(useTabSleepNoticeStore.getState().notice).toEqual({
      kind: 'forkFolderMissing',
      agent: 'claude',
      path: '/home/u/gone',
    })
  })
})
