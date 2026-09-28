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
  const state: { model: FakeModel | null; save: (() => void) | null } = { model: null, save: null }
  const editor = {
    setModel: (m: FakeModel | null) => {
      state.model = m
    },
    getModel: () => state.model,
    addCommand: (_k: number, fn: () => void) => {
      state.save = fn
    },
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
    useEditorStatus.setState(init, true)
  })

  it('does not overwrite a model with unsaved edits when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    act(() => fake.state.model?.setValue('my edit'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/a.txt'))

    expect(fake.state.model?.getValue()).toBe('my edit')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('refreshes a clean model from disk when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView filePath="/w/a.txt" />)

    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined()
  })

  it('keeps the file dirty and shows an error when the write fails', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    vi.mocked(window.pine.fs.write).mockResolvedValue(false)
    render(<EditorView filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save /w/a.txt')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('clears the dirty flag after a successful save', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
    expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed')
  })

  it('shows a binary-file message instead of opening a file containing NUL bytes', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('PNG\0\0data')
    render(<EditorView filePath="/w/img.png" />)

    expect(await screen.findByText(/Binary file/)).toBeInTheDocument()
    expect(fake.models.size).toBe(0)
  })
})

describe('isBinary', () => {
  it('detects a NUL within the first 8KB only', () => {
    expect(isBinary('plain text')).toBe(false)
    expect(isBinary('a\0b')).toBe(true)
    expect(isBinary(`${'x'.repeat(8192)}\0`)).toBe(false)
  })
})
