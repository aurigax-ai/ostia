import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '@/commands/registry'
import { useHiddenPromptsStore } from '@/stores/agents/hiddenPromptsStore'
import { ResumeFolderPrompt } from './ResumePrompts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ResumeFolderPrompt', () => {
  it('says which folder is gone and that nothing was run', () => {
    render(
      <ResumeFolderPrompt
        paneId="p1"
        resume={{ agent: 'claude', id: 'dead1234-0000-4000-8000-000000000000' }}
        folder="/work/tree"
      />,
    )
    expect(screen.getByRole('region', { name: 'Agent folder missing' })).toHaveTextContent(
      'The folder claude worked in no longer exists: /work/tree. Nothing was run.',
    )
  })

  it('offers Close tab, which closes this pane, and a close button that only hides the message', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    render(
      <ResumeFolderPrompt
        paneId="p1"
        resume={{ agent: 'claude', id: 'dead1234-0000-4000-8000-000000000000' }}
        folder="/work/tree"
      />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(exec).toHaveBeenCalledWith('pane.close', { paneId: 'p1' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide this message' }))
    expect(useHiddenPromptsStore.getState().hidden['folder-missing:p1:/work/tree']).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
