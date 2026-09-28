import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useEditorStatus } from '../stores/editorStatusStore'

const fake = vi.hoisted(() => {
  type Listener = () => void
  class FakeModel {
    version = 1
    changeListeners: Listener[] = []
    disposeListeners: Listener[] = []
    constructor(
      public value: string,
      public uri: { toString(): string; path: string },
    ) {}
    getValue() {
      return this.value
    }
    setValue(v: string) {
      this.value = v
      this.version += 1
      for (const l of this.changeListeners) l()
    }
    getAlternativeVersionId() {
      return this.version
    }
    onDidChangeContent(l: Listener) {
      this.changeListeners.push(l)
      return { dispose() {} }
    }
    onWillDispose(l: Listener) {
      this.disposeListeners.push(l)
      return { dispose() {} }
    }
  }
  const models = new Map<string, FakeModel>()
  const state: {
    model: FakeModel | null
    save: (() => void) | null
    actions: { id: string; label: string; run: () => void }[]
    position: { lineNumber: number; column: number } | null
  } = { model: null, save: null, actions: [], position: null }
  const editor = {
    setModel: (m: FakeModel | null) => {
      state.model = m
    },
    getModel: () => state.model,
    addCommand: (_k: number, fn: () => void) => {
      state.save = fn
    },
    addAction: (a: { id: string; label: string; run: () => void }) => {
      state.actions.push(a)
      return {
        dispose: () => {
          state.actions = state.actions.filter((x) => x !== a)
        },
      }
    },
    getPosition: () => state.position,
    updateOptions: () => {},
    dispose: () => {},
  }
  const monaco = {
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    Uri: { file: (p: string) => ({ path: p, toString: () => `file://${p}` }) },
    editor: {
      create: () => editor,
      getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
      createModel: (value: string, _lang: string, uri: { toString(): string; path: string }) => {
        const m = new FakeModel(value, uri)
        models.set(uri.toString(), m)
        return m
      },
    },
  }
  return { monaco, models, state }
})

vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))
vi.mock('../lsp/client', () => ({ openDocument: vi.fn().mockResolvedValue(undefined) }))

const { EditorView, isBinary } = await import('./Editor')

describe('EditorView', () => {
  let init: ReturnType<typeof useEditorStatus.getState>
  beforeAll(() => {
    init = useEditorStatus.getState()
  })
  afterEach(() => {
    fake.models.clear()
    fake.state.model = null
    fake.state.save = null
    fake.state.actions = []
    fake.state.position = null
    useEditorStatus.setState(init, true)
  })

  it('does not overwrite a model with unsaved edits when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    act(() => fake.state.model?.setValue('my edit'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/a.txt'))

    expect(fake.state.model?.getValue()).toBe('my edit')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('refreshes a clean model from disk when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView paneId="p1" filePath="/w/a.txt" />)

    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined()
  })

  it('keeps the file dirty and shows an error when the write fails', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    vi.mocked(window.pine.fs.write).mockResolvedValue(false)
    render(<EditorView paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save /w/a.txt')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('clears the dirty flag after a successful save', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
    expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed')
  })

  it('shows a binary-file message instead of opening a file containing NUL bytes', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('PNG\0\0data')
    render(<EditorView paneId="p1" filePath="/w/img.png" />)

    expect(await screen.findByText(/Binary file/)).toBeInTheDocument()
    expect(fake.models.size).toBe(0)
  })
})

describe('EditorView → Open in External Editor', () => {
  afterEach(() => {
    fake.models.clear()
    fake.state.model = null
    fake.state.actions = []
    fake.state.position = null
  })

  it('opens the file at the cursor with the configured template', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView paneId="p1" filePath="/w/a b.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    fake.state.position = { lineNumber: 12, column: 5 }

    const action = fake.state.actions.find((a) => a.id === 'pine.openExternal')
    expect(action?.label).toBe('Open in External Editor')
    act(() => action?.run())

    await waitFor(() =>
      expect(window.pine.externalEditor.open).toHaveBeenCalledWith({
        template: 'auto',
        file: '/w/a b.ts',
        line: 12,
        column: 5,
      }),
    )
  })

  it('tells the user how to configure an editor when none is found', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    vi.mocked(window.pine.externalEditor.open).mockResolvedValue({ ok: false, error: 'no-editor' })
    render(<EditorView paneId="p1" filePath="/w/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())

    act(() => fake.state.actions[0]?.run())

    expect(await screen.findByRole('alert')).toHaveTextContent(/behavior\.externalEditor/)
  })
})

describe('isBinary', () => {
  it('detects a NUL within the first 8KB only', () => {
    expect(isBinary('plain text')).toBe(false)
    expect(isBinary('a\0b')).toBe(true)
    expect(isBinary(`${'x'.repeat(8192)}\0`)).toBe(false)
  })
})
