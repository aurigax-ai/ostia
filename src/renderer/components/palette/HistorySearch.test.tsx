import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { allPanes } from '@/lib/layout/tree'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHistorySearchStore } from '@/stores/terminal/historySearchStore'
import { useSnippetsStore } from '@/stores/terminal/snippetsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { HistorySearch } from './HistorySearch'

function runCommand(paneId: string, command: string, line: number): void {
  const s = useBlocksStore.getState()
  s.promptStart(paneId, { line }, '/repo')
  s.promptEnd(paneId, { line })
  s.commandStart(paneId, { line: line + 1 }, command)
  s.commandEnd(paneId, { line: line + 2 }, 0)
}

describe('HistorySearch', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let historyInit: ReturnType<typeof useHistorySearchStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>

  beforeAll(() => {
    if (!commands.has('history.insert')) registerBuiltinCommands()
    blocksInit = useBlocksStore.getState()
    historyInit = useHistorySearchStore.getState()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
  })

  afterEach(() => {
    cleanup()
    useBlocksStore.setState(blocksInit, true)
    useHistorySearchStore.setState(historyInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSnippetsStore.setState({ saveCommand: null })
    vi.restoreAllMocks()
  })

  const firstPaneId = (): string => {
    useWorkspacesStore.getState().addWorkspace()
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
    if (!workspaceId) throw new Error('no workspace')
    useLayoutStore.getState().ensure(workspaceId)
    const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
    if (!root) throw new Error('no layout')
    return allPanes(root)[0].id
  }

  it('lists the active pane’s shell history after the session’s, once each', async () => {
    const pane = firstPaneId()
    runCommand(pane, 'git status', 0)
    vi.mocked(window.ostia.pty.history).mockResolvedValue([
      { command: 'make deploy', time: null },
      { command: 'git status', time: null },
      { command: 'make test', time: null },
    ])
    useHistorySearchStore.getState().setOpen(true)
    render(<HistorySearch />)
    expect(await screen.findByText('make test')).toBeVisible()
    expect(window.ostia.pty.history).toHaveBeenCalledWith(pane)
    const rows = screen.getAllByRole('option').map((o) => o.textContent)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('git status')
    expect(rows[1]).toBe('make testShell history')
    expect(rows[2]).toBe('make deployShell history')
    vi.mocked(window.ostia.pty.history).mockReset()
    vi.mocked(window.ostia.pty.history).mockResolvedValue([])
  })

  it('lists commands from the workspace newest first without duplicates', async () => {
    const pane = firstPaneId()
    runCommand(pane, 'git status', 0)
    runCommand(pane, 'make test', 3)
    runCommand(pane, 'git status', 6)
    useHistorySearchStore.getState().setOpen(true)

    render(<HistorySearch />)

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.querySelector('.history-command')?.textContent)).toEqual([
      'git status',
      'make test',
    ])
    expect(options[0]).toHaveTextContent('/repo')
  })

  it('leaves out commands run in a scratch workspace', async () => {
    const pane = firstPaneId()
    runCommand(pane, 'make test', 0)
    useWorkspacesStore
      .getState()
      .addWorkspace('/tmp/ostia-scratch-1000/1-aaaaaaaaaaaa', 'end', 'scratch')
    const scratchId = useWorkspacesStore.getState().activeWorkspaceId as string
    useLayoutStore.getState().ensure(scratchId)
    const scratchRoot = useLayoutStore.getState().byWorkspace[scratchId]?.root
    if (!scratchRoot) throw new Error('no layout')
    runCommand(allPanes(scratchRoot)[0].id, 'curl secret.example', 3)
    useHistorySearchStore.getState().setOpen(true)

    render(<HistorySearch />)

    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.querySelector('.history-command')?.textContent)).toEqual([
      'make test',
    ])
  })

  it('inserts the chosen command into the focused pane and closes', async () => {
    const pane = firstPaneId()
    runCommand(pane, 'make test', 0)
    const exec = vi.spyOn(commands, 'exec')
    useHistorySearchStore.getState().setOpen(true)
    render(<HistorySearch />)

    await userEvent.click(await screen.findByRole('option', { name: /make test/ }))

    expect(exec).toHaveBeenCalledWith('history.insert', { command: 'make test' })
    expect(useHistorySearchStore.getState().open).toBe(false)
  })

  it('saves a past command as a snippet without inserting it', async () => {
    const pane = firstPaneId()
    runCommand(pane, 'make test', 0)
    const exec = vi.spyOn(commands, 'exec')
    useHistorySearchStore.getState().setOpen(true)
    render(<HistorySearch />)

    await userEvent.click(await screen.findByRole('button', { name: 'Save as snippet' }))

    expect(useSnippetsStore.getState().saveCommand).toBe('make test')
    expect(useHistorySearchStore.getState().open).toBe(false)
    expect(exec).not.toHaveBeenCalledWith('history.insert', expect.anything())
  })
})
