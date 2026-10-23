import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/lib/layout/types'
import { useViewModeStore } from '@/stores/files/viewModeStore'
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
  useViewModeStore.setState(useViewModeStore.getInitialState(), true)
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

describe('PaneActions view mode button', () => {
  const file: PaneNode = {
    type: 'pane',
    id: 'p3',
    kind: 'editor',
    title: 'data.csv',
    filePath: '/w/data.csv',
  }

  it('shows the published button of an editor pane and runs it', async () => {
    const act = vi.fn()
    useViewModeStore.getState().publish('p3', { icon: 'viewer', label: 'Open with Table', act })
    render(<PaneActions pane={file} workspaceId="w1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Open with Table' }))
    expect(act).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when the file offers no view mode', () => {
    render(<PaneActions pane={file} workspaceId="w1" />)
    expect(screen.queryByRole('button', { name: /Open with|Run page|Edit page/ })).toBeNull()
  })

  it('shows only the button of its own pane', () => {
    useViewModeStore
      .getState()
      .publish('other', { icon: 'run', label: 'Run page in preview', act: vi.fn() })
    render(<PaneActions pane={file} workspaceId="w1" />)
    expect(screen.queryByRole('button', { name: 'Run page in preview' })).toBeNull()
  })
})
