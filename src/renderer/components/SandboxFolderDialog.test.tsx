import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSandboxStore } from '../stores/sandboxStore'
import { SandboxFolderDialog } from './SandboxFolderDialog'

let init: ReturnType<typeof useSandboxStore.getState>

beforeAll(() => {
  init = useSandboxStore.getState()
})

afterEach(() => {
  useSandboxStore.setState(init, true)
})

describe('SandboxFolderDialog', () => {
  it('says why a home-folder workspace cannot be sandboxed, names the folder and leaves it off', async () => {
    vi.mocked(window.pine.sandbox.setEnabled).mockResolvedValue({
      ok: false,
      reason: 'folder',
      problem: { folder: '/home/u', reason: 'home' },
    })
    render(<SandboxFolderDialog />)
    await act(() => useSandboxStore.getState().setEnabled('ws', true))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('This folder cannot be sandboxed')
    expect(dialog).toHaveTextContent('/home/u is your home folder')
    expect(dialog).toHaveTextContent('Open a project folder as the workspace')
    expect(useSandboxStore.getState().enabled.ws).toBeUndefined()
    expect(useSandboxStore.getState().blocked).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useSandboxStore.getState().refusedFolder).toBeNull()
  })

  it('words a folder above home and one holding Pine data differently', async () => {
    render(<SandboxFolderDialog />)
    act(() =>
      useSandboxStore.setState({ refusedFolder: { folder: '/home', reason: 'above-home' } }),
    )
    expect(await screen.findByRole('dialog')).toHaveTextContent('/home contains your home folder')
    act(() =>
      useSandboxStore.setState({
        refusedFolder: { folder: '/home/u/.config', reason: 'pine-data' },
      }),
    )
    expect(screen.getByRole('dialog')).toHaveTextContent("/home/u/.config holds Pine's own data")
  })
})
