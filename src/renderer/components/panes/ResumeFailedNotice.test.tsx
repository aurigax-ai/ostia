import '@testing-library/jest-dom/vitest'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode, ResumeFailure } from '@/lib/layout/types'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ResumeFailedNotice } from './ResumeFolderNotice'

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

describe('ResumeFailedNotice', () => {
  it('RSM-C10 says which session failed and how, with its actions inline', () => {
    render(<ResumeFailedNotice paneId="p1" failure={failure} />)
    const note = screen.getByRole('region', { name: 'Agent resume failed' })
    expect(note).toHaveTextContent(
      'Couldn’t resume Claude Code session dead1234: it exited with code 1. It won’t be typed again.',
    )
    for (const name of ['Try again', 'Start new session', 'Dismiss']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('RSM-C11 Dismiss clears the note from the pane', () => {
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
    render(<ResumeFailedNotice paneId="p1" failure={failure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')?.resumeFailed).toBe(
      undefined,
    )
  })
})
