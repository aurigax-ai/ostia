import '@testing-library/jest-dom/vitest'
import * as pdfSearch from '@/lib/pdfSearch'
import { useEditorRevealStore } from '@/stores/editorRevealStore'
import { useFileTreeStore } from '@/stores/fileTreeStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { usePdfFindStore } from '@/stores/pdfFindStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspacesStore'
import type { SearchOutcome } from '@shared/search'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FilesPanel } from './FilesPanel'
import { SEARCH_DELAY_MS } from './FilesSearch'

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
    pdfs: [],
    matches: 1,
    truncated: false,
  },
}

function seed(search = true): void {
  useUIStore.setState({ filesSearchOpen: search })
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
    useUIStore.setState({ filesOpen: false, filesSearchOpen: false, filesSearchFocus: false })
    useFileTreeStore.setState({ revealed: null })
    vi.restoreAllMocks()
  })

  it('takes the focus and selects its text when Search Files runs', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)
    const box = screen.getByRole('textbox', { name: 'Search files' }) as HTMLInputElement
    await userEvent.setup().type(box, 'no')
    box.blur()
    act(() => useUIStore.getState().searchFiles())
    expect(box).toHaveFocus()
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 2])
    expect(useUIStore.getState()).toMatchObject({ filesOpen: true, filesSearchFocus: false })
  })

  it('searches for the text Search Files was given', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)
    const box = screen.getByRole('textbox', { name: 'Search files' })

    act(() => useUIStore.getState().searchFiles('notes'))

    expect(box).toHaveValue('notes')
    expect(box).toHaveFocus()
    expect(await screen.findByRole('region', { name: 'Text' })).toHaveTextContent(
      'find the notes here',
    )
    expect(useUIStore.getState().filesSearchQuery).toBeNull()
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

  it('searches the text of PDFs and opens a hit at its page with find on the match', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue({
      ok: true,
      results: {
        root: ROOT,
        names: [],
        files: [],
        pdfs: [{ path: 'docs/paper.pdf', size: 10, mtimeMs: 1 }],
        matches: 0,
        truncated: false,
      },
    })
    vi.spyOn(pdfSearch, 'searchPdfs').mockResolvedValue({
      files: [
        {
          path: 'docs/paper.pdf',
          matches: [{ page: 4, text: 'about Notes', ranges: [[6, 11]], query: 'Notes' }],
        },
      ],
      skipped: 2,
    })
    const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
    render(<FilesPanel />)
    const user = userEvent.setup()

    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'notes')

    const text = await screen.findByRole('region', { name: 'Text' })
    expect(text).toHaveTextContent('docs/paper.pdf')
    expect(text).toHaveTextContent('p. 4')
    expect(
      screen.getByText(
        '2 PDF files were too large or could not be read, so their text was not searched.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /about Notes/ }))
    expect(openFile).toHaveBeenCalledWith('s1', `${ROOT}/docs/paper.pdf`)
    expect(usePdfFindStore.getState().pending[`${ROOT}/docs/paper.pdf`]).toEqual({
      page: 4,
      query: 'Notes',
    })
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

  it('shows the search box with the find key, clears it with Escape and hides it with a second', async () => {
    seed(false)
    render(<FilesPanel />)
    const panel = screen.getByRole('complementary', { name: 'Files' })
    expect(screen.queryByRole('textbox', { name: 'Search files' })).toBeNull()

    fireEvent.keyDown(panel, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    const input = screen.getByRole('textbox', { name: 'Search files' })
    expect(input).toHaveFocus()

    const user = userEvent.setup()
    await user.type(input, 'abc{Escape}')
    expect(input).toHaveValue('')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Search files' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus()
  })

  it('hides the search box with the find key pressed in it and keeps the panel open', async () => {
    seed(false)
    useUIStore.setState({ filesOpen: true })
    render(<FilesPanel />)
    await act(async () => {})
    const panel = screen.getByRole('complementary', { name: 'Files' })

    fireEvent.keyDown(panel, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    const input = screen.getByRole('textbox', { name: 'Search files' })
    fireEvent.keyDown(input, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })

    expect(screen.queryByRole('textbox', { name: 'Search files' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus()
    expect(useUIStore.getState().filesOpen).toBe(true)
  })

  it('names the find key in the header button tooltip when Search Files has no chord', async () => {
    seed(false)
    render(<FilesPanel />)

    await userEvent.setup().hover(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Ctrl+Shift+F')).toBeInTheDocument()
  })

  it('does not search in the background while the box is hidden, and forgets the text', async () => {
    seed()
    vi.mocked(window.ostia.search.run).mockResolvedValue(RESULTS)
    render(<FilesPanel />)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Search files' }), 'notes')
    await screen.findByRole('region', { name: 'Files and folders' })
    const runs = vi.mocked(window.ostia.search.run).mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Search' }))
    act(() => useSettingsStore.getState().setFiles({ searchIgnored: true }))
    await act(() => new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS * 2)))

    expect(window.ostia.search.run).toHaveBeenCalledTimes(runs)
    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('textbox', { name: 'Search files' })).toHaveValue('')
  })

  it('shows and focuses the search box from the header button and hides it again', async () => {
    seed(false)
    render(<FilesPanel />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Search' })
    expect(button).toHaveAttribute('aria-pressed', 'false')

    await user.click(button)
    expect(screen.getByRole('textbox', { name: 'Search files' })).toHaveFocus()
    expect(button).toHaveAttribute('aria-pressed', 'true')

    await user.click(button)
    expect(screen.queryByRole('textbox', { name: 'Search files' })).toBeNull()
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the folders that are open in the tree when the search box is shown and hidden', async () => {
    seed(false)
    vi.mocked(window.ostia.fs.list).mockImplementation(async (p) =>
      p === ROOT ? [{ name: 'src', dir: true }] : [{ name: 'todo.md', dir: false }],
    )
    useSettingsStore.getState().setFiles({ compactFolders: false })
    render(<FilesPanel />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'src' }))
    expect(await screen.findByRole('button', { name: 'todo.md' })).toBeInTheDocument()
    const tree = screen.getByRole('button', { name: 'src' }).closest('.file-tree') as HTMLElement
    tree.scrollTop = 120
    const listed = vi.mocked(window.ostia.fs.list).mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')

    await user.click(screen.getByRole('button', { name: 'Search' }))
    expect(screen.getByRole('button', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'todo.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src' }).closest('.file-tree')).toBe(tree)
    expect(tree.scrollTop).toBe(120)
    expect(window.ostia.fs.list).toHaveBeenCalledTimes(listed)
  })
})
