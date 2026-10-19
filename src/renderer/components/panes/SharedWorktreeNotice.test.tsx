import { PaneAgentNotices } from '@/components/panes/PaneAgentNotices'
import { SharedWorktreeNotice } from '@/components/panes/SharedWorktreeNotice'
import { createPane } from '@/lib/layout/tree'
import { useWorktreeShareStore } from '@/stores/agents/worktreeShareStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const mine = { ...createPane('terminal', 'mine'), id: 'p-mine' }

beforeEach(() => {
  useWorktreeShareStore.setState({ byPane: {} })
})

afterEach(cleanup)

describe('SharedWorktreeNotice', () => {
  it('shows nothing for a pane that shares its worktree with nobody', () => {
    render(<SharedWorktreeNotice pane={mine} />)
    expect(screen.queryByText(/git worktree/)).toBeNull()
  })

  it('names the panes it shares the worktree with, and offers no action', () => {
    useWorktreeShareStore.setState({ byPane: { 'p-mine': ['gone-1'] } })
    render(<SharedWorktreeNotice pane={mine} />)
    expect(
      screen.getByText(
        'Shares this git worktree with another pane. Edits can collide; nothing is resolved for you.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('uses the titles of the panes in the layout', () => {
    useLayoutStore.getState().ensure('ws-share')
    const layout = useLayoutStore.getState().byWorkspace['ws-share']
    const other = layout.root.type === 'pane' ? layout.root : undefined
    expect(other).toBeDefined()
    useWorktreeShareStore.setState({ byPane: { 'p-mine': [other?.id ?? ''] } })
    render(<SharedWorktreeNotice pane={mine} />)
    expect(screen.getByText(new RegExp(`with ${other?.title}`))).toBeInTheDocument()
  })

  it('is what a pane without a resume conflict shows in its strip', () => {
    useWorktreeShareStore.setState({ byPane: { 'p-mine': ['x'] } })
    const { container } = render(<PaneAgentNotices pane={mine} />)
    expect(container.querySelector('[data-shared-worktree]')).toBeInTheDocument()
  })
})
