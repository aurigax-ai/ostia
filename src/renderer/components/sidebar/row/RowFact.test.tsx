import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalPane } from '@/lib/layout/tree'
import { layoutOf } from '@/lib/panes/layoutPatch'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { RowFact } from './RowFact'

const ws = (state: Workspace['state']): Workspace => ({
  id: 'w1',
  name: 'n',
  kind: 'terminal',
  workDir: '/x',
  state,
})

function seed(): string {
  const pane = { ...createTerminalPane('zsh', '/x'), id: 'p1' }
  useLayoutStore.setState({ byWorkspace: { w1: layoutOf(pane) } })
  return pane.id
}

afterEach(cleanup)

describe('RowFact', () => {
  it('draws nothing when no fact is live', () => {
    seed()
    const { container } = render(<RowFact workspace={ws('idle')} offline={null} showLive />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the question in amber while waiting and the failure in red on error', () => {
    const id = seed()
    useAttentionStore
      .getState()
      .dispatch(id, { type: 'set', state: 'waiting', message: 'Allow?', at: 1 })
    const { rerender } = render(<RowFact workspace={ws('waiting')} offline={null} showLive />)
    expect(screen.getByText('Allow?')).toHaveClass('tab-fact', 'waiting')
    act(() => {
      useAttentionStore
        .getState()
        .dispatch(id, { type: 'set', state: 'error', message: 'exit 1', at: 2 })
    })
    rerender(<RowFact workspace={ws('error')} offline={null} showLive />)
    expect(screen.getByText('exit 1')).toHaveClass('error')
  })

  it('shows Offline muted even when live messages are switched off', () => {
    seed()
    render(<RowFact workspace={ws('idle')} offline="Offline · 3 min ago" showLive={false} />)
    expect(screen.getByText('Offline · 3 min ago')).toHaveClass('muted')
  })
})
