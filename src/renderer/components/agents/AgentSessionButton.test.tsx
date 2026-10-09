import { createPane } from '@/layout/tree'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => {
    cleanup()
    useBlocksStore.setState(initial, true)
  })
  it('shows nothing when no agent is running in the pane', () => {
    const pane = createPane('terminal')
    runCommand(pane.id, 'pnpm test')
    const { container } = render(<AgentSessionButton pane={pane} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the running agent with its session title and id', async () => {
    const pane = {
      ...createPane('terminal', '✳ Resume tokens'),
      resume: { agent: 'claude' as const, id: 'abc-123' },
    }
    runCommand(pane.id, 'claude')
    render(<AgentSessionButton pane={pane} />)

    const button = screen.getByRole('button', {
      name: 'Claude Code session: Resume tokens · Resumable',
    })
    fireEvent.click(button)
    expect(await screen.findByText('abc-123')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy resume command' })).toBeTruthy()
  })

  it('adds the model, context, branch and folder the transcript reports, and skips what it lacks', async () => {
    vi.mocked(window.ostia.agentSession.info).mockResolvedValue({
      title: 'Editor highlight',
      model: 'claude-opus-5-5',
      contextTokens: 58010,
      contextWindow: null,
      cwd: '/home/u/proj',
      branch: 'main',
      version: null,
      mode: null,
      effort: 'high',
    })
    const pane = { ...createPane('terminal'), resume: { agent: 'claude' as const, id: 'abc-123' } }
    runCommand(pane.id, 'claude')
    render(<AgentSessionButton pane={pane} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude Code session/ }))

    expect(await screen.findByText('Editor highlight')).toBeTruthy()
    expect(window.ostia.agentSession.info).toHaveBeenCalledWith({ agent: 'claude', id: 'abc-123' })
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy()
    expect(screen.getByText('58.0k')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.queryByText('Version')).toBeNull()
    vi.mocked(window.ostia.agentSession.info).mockResolvedValue(null)
  })

  it('says when the session cannot be resumed', () => {
    const pane = createPane('terminal')
    runCommand(pane.id, 'claude')
    render(<AgentSessionButton pane={pane} />)
    fireEvent.click(screen.getByRole('button', { name: /Not resumable/ }))
    expect(screen.getByText(/has not reported a session id/)).toBeTruthy()
  })
})
