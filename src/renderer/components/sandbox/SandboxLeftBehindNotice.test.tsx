import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { SandboxLeftBehindNotice } from './SandboxLeftBehindNotice'

const notice = (workspaceId: string, paths: string[]) => ({
  workspaceId,
  workDir: '/home/u/proj',
  paths,
})

beforeEach(() => {
  useSandboxStore.setState({ leftBehind: {} })
  useWorkspacesStore.setState({ activeWorkspaceId: 'ws' })
  useUIStore.setState({ filesOpen: false })
  useFileTreeStore.setState({ revealed: null })
})

describe('SandboxLeftBehindNotice', () => {
  it('SBX-C106 names the files and shows the first one in Files on the button', async () => {
    render(<SandboxLeftBehindNotice />)
    act(() => useSandboxStore.getState().noteLeftBehind(notice('ws', ['.envrc', 'sub/.git'])))
    const card = await screen.findByRole('region', { name: 'Files left by the sandbox' })
    expect(card).toHaveTextContent('.envrc, sub/.git')
    await userEvent.click(screen.getByRole('button', { name: 'Show in Files' }))
    expect(useFileTreeStore.getState().revealed).toEqual({
      root: '/home/u/proj',
      path: '/home/u/proj/.envrc',
    })
    expect(useUIStore.getState().filesOpen).toBe(true)
    expect(screen.queryByRole('region', { name: 'Files left by the sandbox' })).toBeNull()
  })

  it('SBX-C107 waits for its workspace and caps the list', async () => {
    render(<SandboxLeftBehindNotice />)
    const paths = ['a/.git', 'b/.git', 'c/.git', 'd/.git', 'e/.git', 'f/.git']
    act(() => useSandboxStore.getState().noteLeftBehind(notice('other', paths)))
    expect(screen.queryByRole('region', { name: 'Files left by the sandbox' })).toBeNull()
    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'other' }))
    const card = await screen.findByRole('region', { name: 'Files left by the sandbox' })
    expect(card).toHaveTextContent('d/.git, 2 more')
    expect(card).not.toHaveTextContent('e/.git')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('region', { name: 'Files left by the sandbox' })).toBeNull()
  })
})
