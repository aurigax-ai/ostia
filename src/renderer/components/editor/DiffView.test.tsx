import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { commands } from '@/commands/registry'
import { editorPositionOf } from '@/lib/files/editorPositions'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useDiffStore } from '@/stores/files/diffStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

const fake = vi.hoisted(() => {
  interface FakeModel {
    value: string
    language: string
    disposed: boolean
    dispose: () => void
  }
  const state = {
    created: 0,
    disposed: 0,
    options: [] as Record<string, unknown>[],
    model: null as { original: FakeModel; modified: FakeModel } | null,
    models: [] as FakeModel[],
    steps: [] as string[],
    position: null as { lineNumber: number; column: number } | null,
  }
  const diff = {
    setModel: (m: { original: FakeModel; modified: FakeModel } | null) => {
      if (state.disposed > 0) throw new Error('InstantiationService has been disposed')
      state.model = m
    },
    updateOptions: (o: Record<string, unknown>) => {
      state.options.push(o)
    },
    getModifiedEditor: () => ({ getPosition: () => state.position }),
    goToDiff: (target: string) => {
      state.steps.push(target)
    },
    dispose: () => {
      state.disposed += 1
    },
  }
  const monaco = {
    editor: {
      setTheme: vi.fn(),
      defineTheme: vi.fn(),
      createDiffEditor: (_host: HTMLElement, options: Record<string, unknown>) => {
        state.created += 1
        state.options.push(options)
        return diff
      },
      createModel: (value: string, language: string) => {
        const m: FakeModel = {
          value,
          language,
          disposed: false,
          dispose() {
            m.disposed = true
          },
        }
        state.models.push(m)
        return m
      },
    },
  }
  return { monaco, state }
})

vi.mock('@/lib/monaco/setup', () => ({
  monaco: fake.monaco,
}))
vi.mock('@/lib/lsp/client', () => ({ openDocument: vi.fn() }))

const { DiffView } = await import('./DiffView')

const CONTENT = {
  title: 'a.ts',
  original: 'const a = 1\n',
  modified: 'const a = 2\n',
  path: '/repo/src/a.ts',
}

describe('DiffView', () => {
  let init: ReturnType<typeof useDiffStore.getState>
  beforeAll(() => {
    init = useDiffStore.getState()
  })
  afterEach(() => {
    cleanup()
    useDiffStore.setState(init, true)
    fake.state.created = 0
    fake.state.disposed = 0
    fake.state.options = []
    fake.state.model = null
    fake.state.models = []
    fake.state.steps = []
    fake.state.position = null
  })

  it('creates a read-only side-by-side diff editor without a theme of its own', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(fake.state.created).toBe(1)
    expect(fake.state.options[0]).toMatchObject({
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
    })
    expect(fake.state.options[0].theme).toBeUndefined()
  })

  it('collapses unchanged regions and bounds the diff computation by time and size', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(fake.state.options[0]).toMatchObject({
      hideUnchangedRegions: { enabled: true },
      maxComputationTime: 2000,
      maxFileSize: 5,
    })
  })

  it('feeds original and modified text with the language inferred from the path', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(fake.state.model?.original).toMatchObject({
      value: CONTENT.original,
      language: 'typescript',
    })
    expect(fake.state.model?.modified).toMatchObject({ value: CONTENT.modified })
    expect(screen.queryByText('/repo/src/a.ts')).toBeNull()
  })

  it('prefers an explicit language and swaps models when the content changes', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    const first = fake.state.model
    act(() => useDiffStore.getState().set('d1', { ...CONTENT, language: 'rust', modified: 'x' }))
    expect(first?.original.disposed).toBe(true)
    expect(first?.modified.disposed).toBe(true)
    expect(fake.state.model?.modified).toMatchObject({ value: 'x', language: 'rust' })
  })

  it('chooses a layout with the segmented toggle and remembers it in editor.diffLayout', () => {
    const settings = useSettingsStore.getState()
    try {
      useDiffStore.getState().set('d1', CONTENT)
      render(<DiffView workspaceId="w1" paneId="d1" />)
      fireEvent.click(screen.getByRole('button', { name: 'Inline view' }))
      expect(useSettingsStore.getState().editor.diffLayout).toBe('inline')
      expect(fake.state.options.at(-1)).toEqual({ renderSideBySide: false })
      expect(screen.getByRole('button', { name: 'Inline view' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      fireEvent.click(screen.getByRole('button', { name: 'Side-by-side view' }))
      expect(useSettingsStore.getState().editor.diffLayout).toBe('sideBySide')
      expect(fake.state.options.at(-1)).toEqual({ renderSideBySide: true })
    } finally {
      cleanup()
      useSettingsStore.setState(settings, true)
    }
  })

  it('groups the layout buttons in the shared Segmented control with the pressed one marked', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    const group = screen.getByRole('group', { name: 'Diff layout' })
    expect(within(group).getAllByRole('button')).toHaveLength(2)
    expect(within(group).getByRole('button', { name: 'Side-by-side view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(group).getByRole('button', { name: 'Inline view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('starts side by side in auto and never lets Monaco switch the layout by itself', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(useSettingsStore.getState().editor.diffLayout).toBe('auto')
    expect(fake.state.options[0]).toMatchObject({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
    })
    expect(screen.getByRole('button', { name: 'Side-by-side view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('opens inline when editor.diffLayout is inline', () => {
    const settings = useSettingsStore.getState()
    useSettingsStore.setState({ editor: { ...settings.editor, diffLayout: 'inline' } })
    try {
      useDiffStore.getState().set('d1', CONTENT)
      render(<DiffView workspaceId="w1" paneId="d1" />)
      expect(fake.state.options).toContainEqual({ renderSideBySide: false })
    } finally {
      cleanup()
      useSettingsStore.setState(settings, true)
    }
  })

  it('moves between changes with the previous and next buttons', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }))
    expect(fake.state.steps).toEqual(['next', 'previous'])
  })

  it('remembers ignore whitespace in editor.diffIgnoreWhitespace and applies it', () => {
    const settings = useSettingsStore.getState()
    try {
      useDiffStore.getState().set('d1', CONTENT)
      render(<DiffView workspaceId="w1" paneId="d1" />)
      const button = screen.getByRole('button', { name: 'Ignore whitespace' })
      expect(button).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(button)
      expect(useSettingsStore.getState().editor.diffIgnoreWhitespace).toBe(true)
      expect(fake.state.options.at(-1)).toEqual({ ignoreTrimWhitespace: true })
      expect(button).toHaveAttribute('aria-pressed', 'true')
    } finally {
      cleanup()
      useSettingsStore.setState(settings, true)
    }
  })

  it('opens the file in the editor from the toolbar', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    const openFile = vi.fn()
    useLayoutStore.setState({ openFile })
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(openFile).toHaveBeenCalledWith('w1', '/repo/src/a.ts')
  })

  it('runs the Git commands from the changed-file buttons without any Git call of its own', async () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    useDiffStore.getState().set('d1', { ...CONTENT, area: 'unstaged' })
    render(<DiffView workspaceId="w1" paneId="d1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous changed file' }))
    expect(exec).toHaveBeenNthCalledWith(1, 'git.openNextChange', { paneId: 'd1' })
    expect(exec).toHaveBeenNthCalledWith(2, 'git.openPreviousChange', { paneId: 'd1' })
    expect(window.ostia.git.changes).not.toHaveBeenCalled()
    exec.mockRestore()
  })

  it('has no changed-file buttons for a diff that did not come from the changes list', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(screen.queryByRole('button', { name: 'Next changed file' })).toBeNull()
    expect(window.ostia.git.changes).not.toHaveBeenCalled()
  })

  it('opens the modified file at the cursor in the external editor', async () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView workspaceId="w1" paneId="d1" />)
    fake.state.position = { lineNumber: 7, column: 2 }
    expect(editorPositionOf('d1')).toEqual({ file: '/repo/src/a.ts', line: 7, column: 2 })

    fireEvent.click(screen.getByRole('button', { name: 'Open in external editor' }))

    await waitFor(() =>
      expect(window.ostia.externalEditor.open).toHaveBeenCalledWith({
        template: 'auto',
        file: '/repo/src/a.ts',
        line: 7,
        column: 2,
      }),
    )
  })

  it('has no external-editor button or position without a path', () => {
    useDiffStore.getState().set('d1', { title: 'x', original: 'a', modified: 'b' })
    render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(screen.queryByRole('button', { name: 'Open in external editor' })).toBeNull()
    expect(editorPositionOf('d1')).toBeNull()
  })

  it('says the diff is gone when its content is missing (e.g. after restore)', () => {
    render(<DiffView workspaceId="w1" paneId="nope" />)
    expect(screen.getByText(/no longer available/)).toBeInTheDocument()
    expect(fake.state.model).toBeNull()
  })

  it('disposes the diff editor and its models on unmount', () => {
    useDiffStore.getState().set('d1', CONTENT)
    const { unmount } = render(<DiffView workspaceId="w1" paneId="d1" />)
    unmount()
    expect(fake.state.disposed).toBe(1)
    expect(fake.state.models.every((m) => m.disposed)).toBe(true)
    expect(editorPositionOf('d1')).toBeNull()
  })
  it('closes without touching the disposed editor, so the window keeps rendering', () => {
    useDiffStore.getState().set('d1', CONTENT)
    const { unmount } = render(<DiffView workspaceId="w1" paneId="d1" />)
    expect(() => unmount()).not.toThrow()
    expect(fake.state.disposed).toBe(1)
    expect(fake.state.models.every((m) => m.disposed)).toBe(true)
  })
})
