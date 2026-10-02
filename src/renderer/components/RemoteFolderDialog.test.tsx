import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRemoteFoldersStore, wireRemoteFolders } from '../stores/remoteFoldersStore'
import { RemoteFolderDialog } from './RemoteFolderDialog'

const ASK = { extName: 'SSH', host: 'dev@db', path: '/srv/app' }

afterEach(() => {
  cleanup()
  useRemoteFoldersStore.setState({ folders: [], pending: null })
  vi.restoreAllMocks()
})

describe('RemoteFolderDialog', () => {
  it('SSH-C58 names the extension, the host and the folder, and answers yes only on Open', async () => {
    const user = userEvent.setup()
    render(<RemoteFolderDialog />)
    const answer = useRemoteFoldersStore.getState().ask(ASK)

    const dialog = await screen.findByTestId('remote-folder-dialog')
    expect(dialog).toHaveTextContent('SSH will show this folder in Files')
    expect(dialog).toHaveTextContent('dev@db')
    expect(dialog).toHaveTextContent('/srv/app')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await answer).toBe(true)
    expect(useRemoteFoldersStore.getState().pending).toBeNull()
  })

  it('answers no on Cancel, on Escape and when a newer question replaces it', async () => {
    const user = userEvent.setup()
    render(<RemoteFolderDialog />)
    const cancelled = useRemoteFoldersStore.getState().ask(ASK)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await cancelled).toBe(false)

    const escaped = useRemoteFoldersStore.getState().ask(ASK)
    await screen.findByTestId('remote-folder-dialog')
    await user.keyboard('{Escape}')
    expect(await escaped).toBe(false)

    const replaced = useRemoteFoldersStore.getState().ask(ASK)
    const latest = useRemoteFoldersStore.getState().ask({ ...ASK, path: '/srv/other' })
    expect(await replaced).toBe(false)
    useRemoteFoldersStore.getState().answer(false)
    expect(await latest).toBe(false)
  })
})

describe('wireRemoteFolders', () => {
  it('loads the folders of this window and follows changes main sends', async () => {
    const folder = {
      id: 'abcdef012345',
      workspaceId: 's1',
      extId: 'ssh',
      extName: 'SSH',
      host: 'dev@db',
      root: '/srv/app',
    }
    vi.mocked(window.pine.remoteFiles.folders).mockResolvedValue([folder])
    wireRemoteFolders()
    await vi.waitFor(() => expect(useRemoteFoldersStore.getState().folders).toEqual([folder]))
    const onFolders = vi.mocked(window.pine.remoteFiles.onFolders).mock.calls.at(-1)?.[0]
    onFolders?.([])
    expect(useRemoteFoldersStore.getState().folders).toEqual([])
    expect(window.pine.remoteFiles.onConfirm).toHaveBeenCalled()
  })
})
