import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as resumeFolder from '@/lib/agents/resumeFolder'
import type { PaneNode } from '@/lib/layout/types'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useHiddenPromptsStore } from '@/stores/agents/hiddenPromptsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { usePanePrompt } from './usePanePrompt'

function Host({ pane }: { pane: PaneNode }): JSX.Element {
  return <div>{usePanePrompt(pane)}</div>
}

const pane: PaneNode = { type: 'pane', id: 'p1', title: 'claude', kind: 'terminal' }

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  useApprovalsStore.setState({ pending: [], history: [] })
  useQuestionsStore.setState({ pending: [] })
  useFolderTrustStore.setState({ byPane: {} })
  useHiddenPromptsStore.setState({ hidden: {} })
})

describe('usePanePrompt', () => {
  it('shows nothing for a pane that waits for nothing', () => {
    const { container } = render(<Host pane={pane} />)
    expect(container.querySelector('section')).toBeNull()
  })

  it('shows one card at a time, a permission request before a folder trust, and the next after the first is answered', () => {
    useFolderTrustStore.setState({ byPane: { p1: '/work/repo' } })
    useApprovalsStore.setState({
      pending: [
        {
          id: 'a1',
          paneId: 'p1',
          workspaceId: 'w1',
          caps: ['shell'],
          action: 'Run',
          detail: '',
          at: 0,
        },
      ],
      history: [],
    })
    render(<Host pane={pane} />)
    expect(screen.getByRole('region', { name: 'Agent permission request' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Claude folder trust' })).toBeNull()

    act(() => useApprovalsStore.setState({ pending: [] }))

    expect(screen.getByRole('region', { name: 'Claude folder trust' })).toBeInTheDocument()
  })

  it('hides a permission request from the pane with its close button and keeps it pending', () => {
    useApprovalsStore.setState({
      pending: [
        {
          id: 'a1',
          paneId: 'p1',
          workspaceId: 'w1',
          caps: ['shell'],
          action: 'Run',
          detail: '',
          at: 0,
        },
      ],
      history: [],
    })
    render(<Host pane={pane} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Decide later. The request waits in the dashboard.' }),
    )

    expect(screen.queryByRole('region', { name: 'Agent permission request' })).toBeNull()
    expect(useApprovalsStore.getState().pending).toHaveLength(1)
  })

  it('shows a resume failure, and the folder-missing message until it is hidden', () => {
    const failed: PaneNode = {
      ...pane,
      resumeFailed: { resume: { agent: 'claude', id: 'dead1234-0000' }, exitCode: 1 },
    }
    const { rerender } = render(<Host pane={failed} />)
    expect(screen.getByRole('region', { name: 'Agent resume failed' })).toBeInTheDocument()

    const missing: PaneNode = {
      ...pane,
      resume: { agent: 'claude', id: 'dead1234-0000' },
      resumeFolderMissing: '/gone',
    }
    rerender(<Host pane={missing} />)
    expect(screen.getByRole('region', { name: 'Agent folder missing' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide this message' }))
    expect(screen.queryByRole('region', { name: 'Agent folder missing' })).toBeNull()

    rerender(<Host pane={{ ...missing, resumeFolderMissing: '/gone-again' }} />)
    expect(screen.getByRole('region', { name: 'Agent folder missing' })).toBeInTheDocument()
  })

  it('forgets a hidden conflict once it ends, so the same holder conflicting again shows again', () => {
    const resuming: PaneNode = { ...pane, resume: { agent: 'claude', id: 's1' } }
    const holder: PaneNode = { type: 'pane', id: 'p2', title: 'other', kind: 'terminal' }
    vi.spyOn(resumeFolder, 'resumeConflict').mockReturnValue(holder)
    const { rerender } = render(<Host pane={resuming} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide this message' }))
    expect(screen.queryByRole('region', { name: 'Agent session open twice' })).toBeNull()

    vi.spyOn(resumeFolder, 'resumeConflict').mockReturnValue(null)
    rerender(<Host pane={{ ...resuming, title: 'claude 2' }} />)
    vi.spyOn(resumeFolder, 'resumeConflict').mockReturnValue(holder)
    rerender(<Host pane={{ ...resuming, title: 'claude 3' }} />)

    expect(screen.getByRole('region', { name: 'Agent session open twice' })).toBeInTheDocument()
  })
})
