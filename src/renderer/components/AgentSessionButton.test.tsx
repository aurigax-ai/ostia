import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createPane } from '../layout/tree'
import { useBlocksStore } from '../stores/blocksStore'
import { AgentSessionButton } from './AgentSessionButton'

function runCommand(paneId: string, command: string): void {
  useBlocksStore.setState({
    byPane: {
      [paneId]: [
        {
          id: 'b1',
          paneId,
          promptLine: { line: 0 },
          inputLine: null,
          outputStartLine: { line: 1 },
          endLine: null,
          endCol: 0,
          command,
          exitCode: null,
          cwd: '/home/u/proj',
          startedAt: Date.now(),
          endedAt: null,
        },
      ],
    },
    running: { [paneId]: 'b1' },
  })
}

describe('AgentSessionButton', () => {
  const initial = useBlocksStore.getState()
  afterEach(() => useBlocksStore.setState(initial, true))

  it('shows nothing when no agent is running in the pane', () => {
    const pane = createPane('terminal')
    runCommand(pane.id, 'pnpm test')
    const { container } = render(<AgentSessionButton pane={pane} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the running agent with its session title and id', () => {
    const pane = {
      ...createPane('terminal', '✳ Resume tokens'),
      resume: { agent: 'claude' as const, id: 'abc-123' },
    }
    runCommand(pane.id, 'claude')
    render(<AgentSessionButton pane={pane} />)

    const button = screen.getByRole('button', { name: 'Claude Code session: Resume tokens' })
    fireEvent.click(button)
    expect(screen.getByText('abc-123')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy resume command' })).toBeTruthy()
  })
})
