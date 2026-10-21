import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PaneNode } from '@/lib/layout/types'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { PaneActions } from './PaneActions'

const agent: PaneNode = {
  type: 'pane',
  id: 'p1',
  kind: 'terminal',
  title: '✳ export',
  resume: { agent: 'claude', id: 's1', cwd: '/a' },
}
const shell: PaneNode = { type: 'pane', id: 'p2', kind: 'terminal', title: 'zsh' }

function runAgent(id: string): void {
  useBlocksStore.getState().promptStart(id, { line: 0 }, null)
  useBlocksStore.getState().commandStart(id, { line: 1 }, 'claude')
  useBlocksStore.getState().markAgent(id, 'claude')
}

afterEach(() => {
  cleanup()
  useBlocksStore.setState(useBlocksStore.getInitialState(), true)
})

describe('PaneActions agent split button', () => {
  it('has the session button and its caret with a running agent, and no separate fork button', () => {
    runAgent('p1')
    render(<PaneActions pane={agent} workspaceId="w1" />)
    expect(screen.getByRole('group', { name: 'Agent actions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Claude Code session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent actions' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Fork conversation/ })).toBeNull()
  })

  it('has neither the session button nor the caret in a plain shell', () => {
    render(<PaneActions pane={shell} workspaceId="w1" />)
    expect(screen.queryByRole('group', { name: 'Agent actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Agent actions' })).toBeNull()
  })
})
