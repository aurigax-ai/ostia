import '@testing-library/jest-dom/vitest'
import type { SearchOutcome } from '@shared/search'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Workspace, useWorkspacesStore } from '../stores/workspacesStore'
import { FilesPanel } from './FilesPanel'

const ROOT = '/home/me/project'

const RESULTS: SearchOutcome = {
  ok: true,
  results: {
    root: ROOT,
    names: [
      { path: 'src/notes', dir: true, positions: [4, 5, 6, 7, 8] },
      { path: 'src/notes/todo.md', dir: false, positions: [4, 5, 6, 7, 8] },
      { path: 'dist/notes.js', dir: false, positions: [5, 6, 7, 8, 9] },
    ],
    files: [
      {
        path: 'src/notes/todo.md',
        matches: [{ line: 2, column: 10, text: 'find the notes here', ranges: [[9, 14]] }],
      },
    ],
    matches: 1,
    truncated: false,
  },
}

function seed(): void {
  const workspace: Workspace = {
    id: 's1',
    name: 'project',
    kind: 'terminal',
    workDir: ROOT,
    state: 'idle',
  }
  useWorkspacesStore.setState({ workspaces: [workspace], activeWorkspaceId: 's1' })
  useLayoutStore.getState().ensure('s1')
  useLayoutStore
    .getState()
    .setCwd('s1', useLayoutStore.getState().byWorkspace.s1.activePaneId, ROOT)
}

describe('Files panel search', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let revealInit: ReturnType<typeof useEditorRevealStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
    revealInit = useEditorRevealStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
    useEditorRevealStore.setState(revealInit, true)
    vi.restoreAllMocks()
  })

  it('searches the tree folder for names and text and lists both', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Search files' }), 'notes')

    const names = await screen.findByRole('region', { name: 'Files and folders' })
    expect(names).toHaveTextContent('src/notes')
    expect(screen.getByRole('region', { name: 'Text' })).toHaveTextContent('find the notes here')
    expect(screen.getByText('1 match in 1 file')).toBeInTheDocument()
    expect(window.ostia.search.run).toHaveBeenLastCalledWith({
      root: ROOT,
      text: 'notes',
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      includeIgnored: false,
    })
  })

  it('leaves out what the tree hides', async () => {
    seed()
    useSettingsStore.getState().setFiles({ exclude: ['**/dist'] })
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Search files' }), 'notes')

    const names = await screen.findByRole('region', { name: 'Files and folders' })
    expect(names).not.toHaveTextContent('dist/notes.js')
  })

  it('passes match case, whole word, regex and the gitignored setting', async () => {
    seed()
    useSettingsStore.getState().setFiles({ searchIgnored: true })
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Match case' }))
    await user.click(screen.getByRole('button', { name: 'Match whole word' }))
    await user.click(screen.getByRole('button', { name: 'Use regular expression' }))
    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'no.es')

    await waitFor(() =>
      expect(window.ostia.search.run).toHaveBeenLastCalledWith({
        root: ROOT,
        text: 'no.es',
        caseSensitive: true,
        wholeWord: true,
        regex: true,
        includeIgnored: true,
      }),
    )
  })

  it('opens a text match at its line', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
    render(<FilesPanel />)
    const user = userEvent.setup()

    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'notes')
    await user.click(await screen.findByRole('button', { name: /find the notes here/ }))

    expect(openFile).toHaveBeenCalledWith('s1', `${ROOT}/src/notes/todo.md`)
    expect(useEditorRevealStore.getState().pending[`${ROOT}/src/notes/todo.md`]).toEqual({
      line: 2,
      column: 10,
    })
  })

  it('reveals a folder hit in the tree and clears the search', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) =>
      p === ROOT
        ? [{ name: 'src', dir: true }]
        : p === `${ROOT}/src`
          ? [
              { name: 'notes', dir: true },
              { name: 'lib', dir: true },
            ]
          : [{ name: 'todo.md', dir: false }],
    )
    useSettingsStore.getState().setFiles({ compactFolders: false })
    render(<FilesPanel />)
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'Search files' })

    await user.type(input, 'notes')
    const names = await screen.findByRole('region', { name: 'Files and folders' })
    await user.click(names.querySelector('button') as HTMLButtonElement)

    expect(input).toHaveValue('')
    const folder = await screen.findByRole('button', { name: 'notes' })
    await waitFor(() => expect(folder).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByRole('button', { name: 'lib' })).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByRole('button', { name: 'todo.md' })).toBeInTheDocument()
  })

  it('says when a regular expression is not valid', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue({
      ok: false,
      error: 'invalid-pattern',
      message: 'regex parse error',
    })
    render(<FilesPanel />)

    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Search files' }), '(')

    expect(await screen.findByRole('alert')).toHaveTextContent('Not a valid regular expression')
  })

  it('focuses the search box with the find key and clears it with Escape', async () => {
    seed()
    render(<FilesPanel />)
    const input = screen.getByRole('textbox', { name: 'Search files' })
    const panel = screen.getByRole('complementary', { name: 'Files' })

    fireEvent.keyDown(panel, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    expect(input).toHaveFocus()

    await userEvent.setup().type(input, 'abc{Escape}')
    expect(input).toHaveValue('')
  })
})
