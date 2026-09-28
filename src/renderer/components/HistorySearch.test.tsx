import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerBuiltinCommands } from '../commands/builtins'
import { commands } from '../commands/registry'
import { allPanes } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { useHistorySearchStore } from '../stores/historySearchStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
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
  let sessionsInit: ReturnType<typeof useSessionsStore.getState>

  beforeAll(() => {
    if (!commands.has('history.insert')) registerBuiltinCommands()
    blocksInit = useBlocksStore.getState()
    historyInit = useHistorySearchStore.getState()
    layoutInit = useLayoutStore.getState()
    sessionsInit = useSessionsStore.getState()
  })

  afterEach(() => {
    useBlocksStore.setState(blocksInit, true)
    useHistorySearchStore.setState(historyInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSessionsStore.setState(sessionsInit, true)
    vi.restoreAllMocks()
  })

  const firstPaneId = (): string => {
    useSessionsStore.getState().addSession()
    const sessionId = useSessionsStore.getState().activeSessionId
    if (!sessionId) throw new Error('no session')
    const root = useLayoutStore.getState().bySession[sessionId]?.root
    if (!root) throw new Error('no layout')
    return allPanes(root)[0].id
  }

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
})
