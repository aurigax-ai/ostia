import '@testing-library/jest-dom/vitest'
import type { ResumeFailure } from '@shared/agents/agentResume'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { ResumeFailedPrompt } from './ResumePrompts'

const failure: ResumeFailure = {
  resume: { agent: 'claude', id: 'dead1234-0000-4000-8000-000000000000' },
  exitCode: 1,
}

const pane: PaneNode = {
  type: 'pane',
  id: 'p1',
  title: 'zsh',
  kind: 'terminal',
  resumeFailed: failure,
}

let init: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  init = useLayoutStore.getState()
})

afterEach(() => {
  cleanup()
  useLayoutStore.setState(init, true)
})

describe('ResumeFailedPrompt', () => {
  it('RSM-C10 says which session failed and how, with its actions inline', () => {
    render(<ResumeFailedPrompt paneId="p1" failure={failure} />)
    const note = screen.getByRole('region', { name: 'Agent resume failed' })
    expect(note).toHaveTextContent(
      'Couldn’t resume Claude Code session dead1234: it exited with code 1. It won’t be typed again.',
    )
    expect(note).toHaveTextContent('Resume failed')
    for (const name of ['Try again', 'Start new session', 'Dismiss']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('RSM-C11 the close button clears the note from the pane', () => {
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
    render(<ResumeFailedPrompt paneId="p1" failure={failure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')?.resumeFailed).toBe(
      undefined,
    )
  })
})
