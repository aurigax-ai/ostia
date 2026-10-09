import '@testing-library/jest-dom/vitest'
import { useEditorStatus } from '@/stores/editorStatusStore'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspacesStore'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FilesView } from './FilesView'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const CWD = '/home/me/project'

function seed(): void {
  const workspace: Workspace = {
    id: 's1',
    name: 'project',
    kind: 'terminal',
    workDir: CWD,
    state: 'idle',
  }
  useWorkspacesStore.setState({ workspaces: [workspace], activeWorkspaceId: 's1' })
  useLayoutStore.getState().ensure('s1')
  vi.mocked(window.ostia.fs.list).mockImplementation(async (dir) =>
    dir === CWD
      ? [
          { name: 'src', dir: true },
          { name: 'notes.md', dir: false },
        ]
      : [],
  )
}

async function menuOn(name: string): Promise<HTMLElement> {
  fireEvent.contextMenu(await screen.findByRole('button', { name }))
  return screen.findByRole('menu')
}

describe('Files tree operations', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let treeInit: ReturnType<typeof useFileTreeStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    treeInit = useFileTreeStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useFileTreeStore.setState(treeInit, true)
    useEditorStatus.setState({ dirty: {} })
    vi.restoreAllMocks()
  })

  it('creates a file inside a folder from its menu and lists the folder again', async () => {
    seed()
    vi.mocked(window.ostia.fileOps.create).mockResolvedValue({
      ok: true,
      paths: [`${CWD}/src/new.ts`],
    })
    render(<FilesView />)
    await userEvent.click(within(await menuOn('src')).getByRole('menuitem', { name: 'New file' }))
    const input = await screen.findByRole('textbox', { name: 'New file name' })
    await userEvent.type(input, 'new.ts{Enter}')
    expect(window.ostia.fileOps.create).toHaveBeenCalledWith(`${CWD}/src`, 'new.ts', 'file')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'New file name' })).toBeNull())
    expect(useFileTreeStore.getState().versions[`${CWD}/src`]).toBe(1)
  })

  it('draws the new folder field as a tree row aligned with its siblings', async () => {
    seed()
    render(<FilesView />)
    const sibling = await screen.findByRole('button', { name: 'src' })
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const input = await screen.findByRole('textbox', { name: 'New folder name' })
    const row = input.closest('.file-row') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.style.paddingLeft).toBe(sibling.style.paddingLeft)
    expect(row.querySelector('.file-twisty')).not.toBeNull()
    expect(row.querySelector('.file-icon')).not.toBeNull()
  })

  it('draws the rename field in the file row with its own icon and the name selected', async () => {
    seed()
    render(<FilesView />)
    const sibling = await screen.findByRole('button', { name: 'src' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'notes.md' }), { key: 'F2' })
    const input = (await screen.findByRole('textbox', {
      name: 'New name for notes.md',
    })) as HTMLInputElement
    const row = input.closest('.file-row') as HTMLElement
    expect(row.style.paddingLeft).toBe(sibling.style.paddingLeft)
    expect(row.querySelector('.file-twisty-spacer')).not.toBeNull()
    expect(row.querySelector('.file-icon')).not.toBeNull()
    await waitFor(() => expect(input.selectionEnd).toBe('notes'.length))
    expect(input.selectionStart).toBe(0)
  })

  it('keeps the name field open with a warning when the name is taken', async () => {
    seed()
    vi.mocked(window.ostia.fileOps.create).mockResolvedValue({ ok: false, error: 'exists' })
    render(<FilesView />)
    await userEvent.click(await screen.findByRole('button', { name: 'New folder' }))
    await userEvent.type(
      await screen.findByRole('textbox', { name: 'New folder name' }),
      'src{Enter}',
    )
    expect(await screen.findByText('Something with this name is already there.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'New folder name' })).toHaveValue('src')
  })

  it('renames on F2 and moves an open editor to the new path', async () => {
    seed()
    useLayoutStore.getState().openFile('s1', `${CWD}/notes.md`)
    vi.mocked(window.ostia.fileOps.rename).mockResolvedValue({
      ok: true,
      paths: [`${CWD}/readme.md`],
    })
    render(<FilesView />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'notes.md' }), { key: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'New name for notes.md' })
    await userEvent.clear(input)
    await userEvent.type(input, 'readme.md{Enter}')
    expect(window.ostia.fileOps.rename).toHaveBeenCalledWith(`${CWD}/notes.md`, 'readme.md')
    await waitFor(() => {
      const panes = Object.values(useLayoutStore.getState().byWorkspace)
      const root = panes[0]?.root
      expect(JSON.stringify(root)).toContain(`${CWD}/readme.md`)
    })
  })

  it('refuses to rename a file with unsaved changes', async () => {
    seed()
    useEditorStatus.setState({ dirty: { [`${CWD}/notes.md`]: true } })
    render(<FilesView />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'notes.md' }), { key: 'F2' })
    const input = await screen.findByRole('textbox', { name: 'New name for notes.md' })
    await userEvent.clear(input)
    await userEvent.type(input, 'readme.md{Enter}')
    expect(
      await screen.findByText('notes.md has unsaved changes. Save or discard them first.'),
    ).toBeVisible()
    expect(window.ostia.fileOps.rename).not.toHaveBeenCalled()
  })

  it('asks before moving to the Trash and trashes only on confirm', async () => {
    seed()
    render(<FilesView />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'notes.md' }), { key: 'Delete' })
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Move “notes.md” to the Trash?')).toBeVisible()
    expect(window.ostia.fileOps.trash).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Trash' }))
    expect(window.ostia.fileOps.trash).toHaveBeenCalledWith([`${CWD}/notes.md`])
  })

  it('cuts and pastes into a folder as a move, then forgets the cut', async () => {
    seed()
    render(<FilesView />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'notes.md' }), {
      key: 'x',
      ctrlKey: true,
    })
    expect(screen.getByRole('button', { name: 'notes.md' })).toHaveClass('cut')
    fireEvent.keyDown(screen.getByRole('button', { name: 'src' }), { key: 'v', ctrlKey: true })
    await waitFor(() =>
      expect(window.ostia.fileOps.move).toHaveBeenCalledWith([`${CWD}/notes.md`], `${CWD}/src`),
    )
    expect(useFileTreeStore.getState().clipboard).toBeNull()
  })

  it('copies on paste after Copy and keeps the clipboard', async () => {
    seed()
    render(<FilesView />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'notes.md' }), {
      key: 'c',
      ctrlKey: true,
    })
    fireEvent.keyDown(screen.getByRole('button', { name: 'src' }), { key: 'v', ctrlKey: true })
    await waitFor(() =>
      expect(window.ostia.fileOps.copy).toHaveBeenCalledWith([`${CWD}/notes.md`], `${CWD}/src`),
    )
    expect(useFileTreeStore.getState().clipboard).toEqual({
      mode: 'copy',
      paths: [`${CWD}/notes.md`],
    })
  })
})
