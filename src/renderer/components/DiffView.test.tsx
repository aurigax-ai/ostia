import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { editorPositionOf } from '../lib/editorPositions'
import { useDiffStore } from '../stores/diffStore'
import { useSettingsStore } from '../stores/settingsStore'

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

vi.mock('../monaco/setup', () => ({
  monaco: fake.monaco,
}))
vi.mock('../lsp/client', () => ({ openDocument: vi.fn() }))

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
    fake.state.position = null
  })

  it('creates a read-only side-by-side diff editor themed like the editor', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView paneId="d1" />)
    expect(fake.state.created).toBe(1)
    expect(fake.state.options[0]).toMatchObject({
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      theme: 'ostia-scheme-adeberry',
    })
  })

  it('feeds original and modified text with the language inferred from the path', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView paneId="d1" />)
    expect(fake.state.model?.original).toMatchObject({
      value: CONTENT.original,
      language: 'typescript',
    })
    expect(fake.state.model?.modified).toMatchObject({ value: CONTENT.modified })
    expect(screen.getByText('/repo/src/a.ts')).toBeInTheDocument()
  })

  it('prefers an explicit language and swaps models when the content changes', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView paneId="d1" />)
    const first = fake.state.model
    act(() => useDiffStore.getState().set('d1', { ...CONTENT, language: 'rust', modified: 'x' }))
    expect(first?.original.disposed).toBe(true)
    expect(first?.modified.disposed).toBe(true)
    expect(fake.state.model?.modified).toMatchObject({ value: 'x', language: 'rust' })
  })

  it('toggles between side-by-side and inline', () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView paneId="d1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Inline view' }))
    expect(fake.state.options.at(-1)).toEqual({ renderSideBySide: false })
    fireEvent.click(screen.getByRole('button', { name: 'Side-by-side view' }))
    expect(fake.state.options.at(-1)).toEqual({ renderSideBySide: true })
  })

  it('opens inline when editor.diffLayout is inline, and the button still switches', () => {
    const settings = useSettingsStore.getState()
    useSettingsStore.setState({ editor: { ...settings.editor, diffLayout: 'inline' } })
    try {
      useDiffStore.getState().set('d1', CONTENT)
      render(<DiffView paneId="d1" />)
      expect(fake.state.options).toContainEqual({ renderSideBySide: false })
      fireEvent.click(screen.getByRole('button', { name: 'Side-by-side view' }))
      expect(fake.state.options.at(-1)).toEqual({ renderSideBySide: true })
    } finally {
      useSettingsStore.setState(settings, true)
    }
  })

  it('opens the modified file at the cursor in the external editor', async () => {
    useDiffStore.getState().set('d1', CONTENT)
    render(<DiffView paneId="d1" />)
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
    render(<DiffView paneId="d1" />)
    expect(screen.queryByRole('button', { name: 'Open in external editor' })).toBeNull()
    expect(editorPositionOf('d1')).toBeNull()
  })

  it('says the diff is gone when its content is missing (e.g. after restore)', () => {
    render(<DiffView paneId="nope" />)
    expect(screen.getByText(/no longer available/)).toBeInTheDocument()
    expect(fake.state.model).toBeNull()
  })

  it('disposes the diff editor and its models on unmount', () => {
    useDiffStore.getState().set('d1', CONTENT)
    const { unmount } = render(<DiffView paneId="d1" />)
    unmount()
    expect(fake.state.disposed).toBe(1)
    expect(fake.state.models.every((m) => m.disposed)).toBe(true)
    expect(editorPositionOf('d1')).toBeNull()
  })
  it('closes without touching the disposed editor, so the window keeps rendering', () => {
    useDiffStore.getState().set('d1', CONTENT)
    const { unmount } = render(<DiffView paneId="d1" />)
    expect(() => unmount()).not.toThrow()
    expect(fake.state.disposed).toBe(1)
    expect(fake.state.models.every((m) => m.disposed)).toBe(true)
  })
})
