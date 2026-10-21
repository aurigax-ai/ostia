import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { NoPreview } from './NoPreview'

const openPath = () => vi.mocked(window.ostia.openPath)

describe('NoPreview', () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w', title: 'w', workDir: '/w' }] as never,
      activeWorkspaceId: 'w',
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers the default app first and Show in Files second, with one line and no file name', async () => {
    openPath().canOpenDefault.mockResolvedValue(true)
    render(<NoPreview workspaceId="w" filePath="/w/model.blend" />)
    expect(screen.getByText('No preview for this file.')).toBeInTheDocument()
    const open = await screen.findByRole('button', { name: 'Open with default app' })
    expect(screen.getByRole('button', { name: 'Show in Files' })).toBeInTheDocument()
    expect(screen.queryByText(/model\.blend/)).toBeNull()
    await userEvent.click(open)
    expect(openPath().openDefault).toHaveBeenCalledWith('/w/model.blend')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows only Show in Files for a program and reveals the file in the tree', async () => {
    openPath().canOpenDefault.mockResolvedValue(false)
    render(<NoPreview workspaceId="w" filePath="/w/setup.exe" />)
    await waitFor(() => expect(openPath().canOpenDefault).toHaveBeenCalledWith('/w/setup.exe'))
    expect(screen.queryByRole('button', { name: 'Open with default app' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show in Files' }))
    expect(useFileTreeStore.getState().revealed).toEqual({ root: '/w', path: '/w/setup.exe' })
    expect(openPath().openDefault).not.toHaveBeenCalled()
  })

  it('says inline when the open failed', async () => {
    openPath().canOpenDefault.mockResolvedValue(true)
    openPath().openDefault.mockResolvedValue({ ok: false, error: 'failed' })
    render(<NoPreview workspaceId="w" filePath="/w/model.blend" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open with default app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open this file.')
  })
})
