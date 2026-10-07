import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TARGET_PANE, seedSendTarget } from '../../../test/mocks/sendTarget'
import { commands } from '../commands/registry'
import { openSelectionSend } from '../lib/selectionSenders'
import { useEditorStatus } from '../stores/editorStatusStore'
import { useLiveSelectionStore } from '../stores/liveSelectionStore'
import { useSettingsStore } from '../stores/settingsStore'

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
      for (const l of state.contentListeners) l()
    }
    getAlternativeVersionId() {
      return this.version
    }
    undoStack: string[] = []
    getFullModelRange() {
      return { startLineNumber: 1, startColumn: 1, endLineNumber: 1e9, endColumn: 1 }
    }
    offsetAt(line: number, column: number) {
      const lines = this.value.split('\n')
      let offset = 0
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) offset += lines[i].length + 1
      return Math.min(offset + column - 1, this.value.length)
    }
    pushEditOperations(
      _before: unknown,
      ops: {
        range: {
          startLineNumber: number
          startColumn: number
          endLineNumber: number
          endColumn: number
        }
        text: string
      }[],
    ) {
      this.undoStack.push(this.value)
      const op = ops[0]
      if (!op) return null
      const start = this.offsetAt(op.range.startLineNumber, op.range.startColumn)
      const end = this.offsetAt(op.range.endLineNumber, op.range.endColumn)
      this.setValue(this.value.slice(0, start) + op.text + this.value.slice(end))
      return null
    }
    undo() {
      const previous = this.undoStack.pop()
      if (previous !== undefined) this.setValue(previous)
    }
    getValueInRange(r: { startLineNumber: number; endLineNumber: number }) {
      return this.value
        .split('\n')
        .slice(r.startLineNumber - 1, r.endLineNumber)
        .join('\n')
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
  interface FakeSelection {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
    isEmpty(): boolean
  }
  const state: {
    model: FakeModel | null
    save: (() => void) | null
    actions: { id: string; label: string; run: () => void }[]
    position: { lineNumber: number; column: number } | null
    selection: FakeSelection | null
    contentListeners: Listener[]
    selectionListeners: Listener[]
    blurListeners: Listener[]
    keyListeners: ((e: unknown) => void)[]
    modelListeners: Listener[]
    formatRuns: (() => void) | null
    decorations: {
      range: { startLineNumber: number; endLineNumber: number }
      options: { className?: string }
    }[]
    createOptions: Record<string, unknown> | null
    optionUpdates: Record<string, unknown>[]
  } = {
    createOptions: null,
    optionUpdates: [],
    model: null,
    save: null,
    actions: [],
    position: null,
    selection: null,
    contentListeners: [],
    selectionListeners: [],
    blurListeners: [],
    keyListeners: [],
    modelListeners: [],
    formatRuns: null,
    decorations: [],
  }
  const listen = (list: Listener[], l: Listener) => {
    list.push(l)
    return {
      dispose: () => {
        const at = list.indexOf(l)
        if (at >= 0) list.splice(at, 1)
      },
    }
  }
  const editor = {
    setModel: (m: FakeModel | null) => {
      state.model = m
      for (const l of [...state.modelListeners]) l()
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
    saveViewState: () => ({ position: state.position }),
    restoreViewState: (view: { position: typeof state.position } | null) => {
      if (view) state.position = view.position
    },
    pushUndoStop: () => true,
    createDecorationsCollection: (items: typeof state.decorations) => {
      state.decorations = items
      return {
        clear: () => {
          state.decorations = []
        },
      }
    },
    getSelection: () => state.selection,
    updateOptions: (o: Record<string, unknown>) => {
      state.optionUpdates.push(o)
    },
    onDidChangeModelContent: (l: Listener) => listen(state.contentListeners, l),
    onDidChangeCursorSelection: (l: Listener) => listen(state.selectionListeners, l),
    onDidBlurEditorText: (l: Listener) => listen(state.blurListeners, l),
    onKeyDown: (l: (e: unknown) => void) => listen(state.keyListeners as Listener[], l as Listener),
    getAction: (id: string) =>
      id === 'editor.action.formatDocument' && state.formatRuns
        ? { run: async () => state.formatRuns?.() }
        : null,
    onDidChangeModel: (l: Listener) => listen(state.modelListeners, l),
    dispose: () => {},
  }
  const monaco = {
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    Uri: { file: (p: string) => ({ path: p, toString: () => `file://${p}` }) },
    editor: {
      setTheme: vi.fn(),
      defineTheme: vi.fn(),
      create: (_host: unknown, options: Record<string, unknown>) => {
        state.createOptions = options
        return editor
      },
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

vi.mock('../monaco/setup', () => ({
  monaco: fake.monaco,
}))
vi.mock('../lsp/client', () => ({
  openDocument: vi.fn(() => () => {}),
  documentSaved: vi.fn(),
}))

const { EditorView } = await import('./Editor')

describe('EditorView', () => {
  let init: ReturnType<typeof useEditorStatus.getState>
  let initSettings: ReturnType<typeof useSettingsStore.getState>
  beforeAll(() => {
    init = useEditorStatus.getState()
    initSettings = useSettingsStore.getState()
  })
  afterEach(() => {
    cleanup()
    fake.models.clear()
    fake.state.model = null
    fake.state.save = null
    fake.state.actions = []
    fake.state.position = null
    fake.state.formatRuns = null
    fake.state.decorations = []
    fake.state.createOptions = null
    fake.state.optionUpdates = []
    useSettingsStore.setState(initSettings, true)
    useEditorStatus.setState(init, true)
  })

  it('opens a Markdown file in the preview when editor.markdownPreview is on, other files as source', async () => {
    useSettingsStore.setState({
      editor: { ...useSettingsStore.getState().editor, markdownPreview: true },
    })
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: '# Title\n\nPreview body' })
    const md = render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/README.md" />)
    expect(await screen.findByText('Preview body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Markdown source' })).toBeInTheDocument()
    md.unmount()
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'const a = 1' })
    render(<EditorView workspaceId="w1" paneId="p2" filePath="/w/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Edit Markdown source' })).toBeNull()
  })

  it('scrolls without smooth animation while motion is reduced', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    act(() => useSettingsStore.getState().setMotion('reduced'))
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    expect(fake.state.createOptions?.smoothScrolling).toBe(false)

    act(() => useSettingsStore.getState().setMotion('full'))
    expect(fake.state.optionUpdates.at(-1)).toEqual({ smoothScrolling: true })
  })

  it('does not overwrite a model with unsaved edits when the file is reopened', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'disk v1' })
    const { rerender } = render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    act(() => fake.state.model?.setValue('my edit'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)

    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'disk v2' })
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/a.txt'))

    expect(fake.state.model?.getValue()).toBe('my edit')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('refreshes a clean model from disk when the file is reopened', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'disk v1' })
    const { rerender } = render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'disk v2' })
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)

    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined()
  })

  it('keeps the file dirty and shows an error when the write fails', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    vi.mocked(window.ostia.fs.write).mockResolvedValue(false)
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save /w/a.txt')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('clears the dirty flag after a successful save', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
    expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed')
  })

  it('formats the document before writing when format on save is on', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    useSettingsStore.setState({
      editor: { ...useSettingsStore.getState().editor, formatOnSave: true },
    })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('unformatted'))
    fake.state.formatRuns = () => fake.state.model?.setValue('formatted')

    act(() => fake.state.save?.())

    await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'formatted'))
    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
  })

  it('just saves when format on save is on but no formatter exists', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    useSettingsStore.setState({
      editor: { ...useSettingsStore.getState().editor, formatOnSave: true },
    })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed'))
  })

  it('auto-saves one second after the last edit when auto save is afterDelay', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    useSettingsStore.setState({
      editor: { ...useSettingsStore.getState().editor, autoSave: 'afterDelay' },
    })
    const fileWrites = () =>
      vi.mocked(window.ostia.fs.write).mock.calls.filter(([path]) => path === '/w/a.txt')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    vi.useFakeTimers()
    try {
      act(() => fake.state.model?.setValue('one'))
      await vi.advanceTimersByTimeAsync(600)
      act(() => fake.state.model?.setValue('two'))
      await vi.advanceTimersByTimeAsync(600)
      expect(fileWrites()).toEqual([])
      await vi.advanceTimersByTimeAsync(500)
      expect(fileWrites()).toEqual([['/w/a.txt', 'two']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-save on a timer when auto save is off', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    vi.useFakeTimers()
    try {
      act(() => fake.state.model?.setValue('one'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(window.ostia.fs.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-saves a dirty file when the editor loses focus and auto save is onFocusChange', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    useSettingsStore.setState({
      editor: { ...useSettingsStore.getState().editor, autoSave: 'onFocusChange' },
    })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))
    expect(window.ostia.fs.write).not.toHaveBeenCalled()

    act(() => {
      for (const l of fake.state.blurListeners) l()
    })

    await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed'))
  })

  it('shows a binary-file message instead of opening a file main reports as binary', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'binary' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/blob.bin" />)

    expect(await screen.findByText(/Binary file/)).toBeInTheDocument()
    expect(fake.models.size).toBe(0)
  })

  it('opens no model and writes nothing when the file cannot be read', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'unreadable' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/locked.txt" />)

    expect(await screen.findByText(/Could not read this file/)).toBeInTheDocument()
    expect(fake.models.size).toBe(0)
    expect(fake.state.model).toBeNull()
    await act(async () => fake.state.save?.())
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
  })

  it('shows a too-large message without opening a model', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({
      ok: false,
      error: 'too-large',
      size: 60 * 1024 * 1024,
    })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/huge.log" />)

    expect(
      await screen.findByText(/too large to open in the editor \(60\.0 MB\)/),
    ).toBeInTheDocument()
    expect(fake.models.size).toBe(0)
  })

  it('refuses to save when the file can no longer be read', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'unreadable' })
    act(() => fake.state.save?.())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save /w/a.txt')
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  describe('following the file on disk', () => {
    let changed: ((c: { path: string; exists: boolean }) => void) | null = null
    let disk: string | null = 'disk v1'

    beforeEach(() => {
      changed = null
      disk = 'disk v1'
      vi.mocked(window.ostia.fs.read).mockImplementation(async () =>
        disk === null ? { ok: false, error: 'missing' } : { ok: true, text: disk },
      )
      vi.mocked(window.ostia.fs.onChanged).mockImplementation((cb) => {
        changed = cb
        return () => {
          changed = null
        }
      })
    })

    async function open(): Promise<void> {
      render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
      await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))
      await waitFor(() => expect(window.ostia.fs.watch).toHaveBeenCalledWith('/w/a.txt'))
    }

    async function diskChanges(next: string | null): Promise<void> {
      disk = next
      await act(async () => {
        changed?.({ path: '/w/a.txt', exists: next !== null })
        await new Promise((r) => setTimeout(r, 0))
      })
    }

    it('ERL-C4 picks up a change when the window regains focus', async () => {
      await open()
      disk = 'disk v2'
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await new Promise((r) => setTimeout(r, 0))
      })
      await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
    })

    it('ERL-C5 reloads a clean file in place, keeps the cursor, and undo restores the old text', async () => {
      await open()
      fake.state.position = { lineNumber: 40, column: 3 }
      await diskChanges('disk v2')
      await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
      expect(fake.state.position).toEqual({ lineNumber: 40, column: 3 })
      expect(useEditorStatus.getState().dirty['/w/a.txt']).not.toBe(true)
      act(() => (fake.state.model as unknown as { undo(): void }).undo())
      expect(fake.state.model?.getValue()).toBe('disk v1')
    })

    it('ERL-C6 leaves the editor alone when the disk bytes did not change', async () => {
      await open()
      const version = fake.state.model?.getAlternativeVersionId()
      await diskChanges('disk v1')
      expect(fake.state.model?.getAlternativeVersionId()).toBe(version)
    })

    it('ERL-C7 never touches unsaved edits and shows the changed-on-disk bar', async () => {
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      await diskChanges('agent edit')
      const bar = await screen.findByRole('alert')
      expect(bar).toHaveTextContent('Changed on disk')
      for (const name of ['Compare', 'Reload', 'Keep mine']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument()
      }
      expect(fake.state.model?.getValue()).toBe('my edit')
    })

    it('ERL-C8 compares my text with the disk, or reloads the disk text', async () => {
      const { useLayoutStore } = await import('../stores/layoutStore')
      const openDiff = vi.spyOn(useLayoutStore.getState(), 'openDiff').mockReturnValue('d1')
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      await diskChanges('agent edit')
      await userEvent.click(await screen.findByRole('button', { name: 'Compare' }))
      expect(openDiff).toHaveBeenCalledWith(
        'w1',
        expect.objectContaining({ original: 'agent edit', modified: 'my edit', path: '/w/a.txt' }),
      )
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
      expect(fake.state.model?.getValue()).toBe('agent edit')
      expect(screen.queryByRole('alert')).toBeNull()
      openDiff.mockRestore()
    })

    it('ERL-C9 pauses autosave while the disk changed under unsaved edits', async () => {
      useSettingsStore.setState({
        editor: { ...useSettingsStore.getState().editor, autoSave: 'onFocusChange' },
      })
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      await diskChanges('agent edit')
      await screen.findByRole('alert')
      vi.mocked(window.ostia.fs.write).mockClear()
      await act(async () => {
        for (const l of fake.state.blurListeners) l()
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(window.ostia.fs.write).not.toHaveBeenCalled()
    })

    it('ERL-C10 brings the bar back when the disk changes again after Keep mine', async () => {
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      await diskChanges('agent edit')
      await userEvent.click(await screen.findByRole('button', { name: 'Keep mine' }))
      expect(screen.queryByRole('alert')).toBeNull()
      await diskChanges('agent edit 2')
      expect(await screen.findByRole('alert')).toHaveTextContent('Changed on disk')
    })

    it('ERL-C11 holds a save over a newer disk file until the human chooses Overwrite', async () => {
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      disk = 'agent edit'
      vi.mocked(window.ostia.fs.write).mockClear()
      await act(async () => {
        fake.state.save?.()
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(window.ostia.fs.write).not.toHaveBeenCalled()
      for (const name of ['Overwrite', 'Compare', 'Cancel']) {
        expect(await screen.findByRole('button', { name })).toBeInTheDocument()
      }
      await userEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
      await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'my edit'))
    })

    it('ERL-C12 saves straight away when the disk still holds what was loaded', async () => {
      await open()
      act(() => fake.state.model?.setValue('my edit'))
      vi.mocked(window.ostia.fs.write).mockClear()
      await act(async () => {
        fake.state.save?.()
        await new Promise((r) => setTimeout(r, 0))
      })
      await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'my edit'))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('ERL-C13 keeps the text of a file deleted on disk, and saving writes it back', async () => {
      await open()
      await diskChanges(null)
      expect(await screen.findByRole('alert')).toHaveTextContent('Deleted on disk')
      expect(fake.state.model?.getValue()).toBe('disk v1')
      vi.mocked(window.ostia.fs.write).mockClear()
      await act(async () => {
        fake.state.save?.()
        await new Promise((r) => setTimeout(r, 0))
      })
      await waitFor(() => expect(window.ostia.fs.write).toHaveBeenCalledWith('/w/a.txt', 'disk v1'))
    })

    it('ERL-C19 highlights the lines a reload changed, then removes the highlight', async () => {
      disk = 'l1\nl2\nl3\nl4\nl5'
      render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
      await waitFor(() => expect(fake.state.model?.getValue()).toBe('l1\nl2\nl3\nl4\nl5'))
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        await diskChanges('l1\nl2\nNEW3\nNEW4\nl5')
        await waitFor(() => expect(fake.state.decorations).toHaveLength(1))
        expect(fake.state.decorations[0].range).toMatchObject({
          startLineNumber: 3,
          endLineNumber: 4,
        })
        expect(fake.state.decorations[0].options.className).toBe('editor-reload-highlight')
        await act(async () => {
          vi.advanceTimersByTime(2100)
        })
        expect(fake.state.decorations).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('ERL-C20 never highlights the human’s own typing', async () => {
      await open()
      act(() => fake.state.model?.setValue('typed by me'))
      expect(fake.state.decorations).toEqual([])
    })

    it('ERL-C21 shows the highlight without a fade under reduced motion and still removes it', async () => {
      useSettingsStore.setState({
        appearance: { ...useSettingsStore.getState().appearance, motion: 'reduced' },
      })
      await open()
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        await diskChanges('disk v2')
        await waitFor(() => expect(fake.state.decorations).toHaveLength(1))
        expect(fake.state.decorations[0].options.className).toBe(
          'editor-reload-highlight editor-reload-highlight-static',
        )
        await act(async () => {
          vi.advanceTimersByTime(2100)
        })
        expect(fake.state.decorations).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('ERL-C14 treats a deleted file that reappears as a change', async () => {
      await open()
      await diskChanges(null)
      await screen.findByRole('alert')
      await diskChanges('reborn')
      await waitFor(() => expect(fake.state.model?.getValue()).toBe('reborn'))
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })
})

describe('EditorView → Open in External Editor', () => {
  afterEach(() => {
    cleanup()
    fake.models.clear()
    fake.state.model = null
    fake.state.actions = []
    fake.state.position = null
  })

  it('opens the file at the cursor with the configured template', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a b.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    fake.state.position = { lineNumber: 12, column: 5 }

    const action = fake.state.actions.find((a) => a.id === 'ostia.openExternal')
    expect(action?.label).toBe('Open in External Editor')
    act(() => action?.run())

    await waitFor(() =>
      expect(window.ostia.externalEditor.open).toHaveBeenCalledWith({
        template: 'auto',
        file: '/w/a b.ts',
        line: 12,
        column: 5,
      }),
    )
  })

  it('tells the user how to configure an editor when none is found', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    vi.mocked(window.ostia.externalEditor.open).mockResolvedValue({ ok: false, error: 'no-editor' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())

    act(() => fake.state.actions[0]?.run())

    expect(await screen.findByRole('alert')).toHaveTextContent(/behavior\.externalEditor/)
  })
})

describe('EditorView → Send Selection to Agent', () => {
  let unseed: () => void
  beforeEach(() => {
    unseed = seedSendTarget('w1')
    vi.mocked(window.ostia.selection.send).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1/selection-1.md',
      imagePath: null,
    })
  })
  afterEach(() => {
    cleanup()
    unseed()
    fake.models.clear()
    fake.state.model = null
    fake.state.actions = []
    fake.state.selection = null
  })

  const select = (startLine: number, startColumn: number, endLine: number, endColumn: number) => {
    fake.state.selection = {
      startLineNumber: startLine,
      startColumn,
      endLineNumber: endLine,
      endColumn,
      isEmpty: () => startLine === endLine && startColumn === endColumn,
    }
  }

  it('reports the selected lines for the workspace’s chat, and clears them when the selection ends', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'one\ntwo\nthree' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/src/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    const reported = () => useLiveSelectionStore.getState().byWorkspace.w1

    select(2, 1, 3, 6)
    for (const listener of fake.state.selectionListeners) listener()
    await waitFor(() =>
      expect(reported()).toEqual({
        paneId: 'p1',
        source: { kind: 'editor', file: '/w/src/a.ts', startLine: 2, endLine: 3 },
        text: 'two\nthree',
      }),
    )

    select(3, 6, 3, 6)
    for (const listener of fake.state.selectionListeners) listener()
    await waitFor(() => expect(reported()).toBeUndefined())
  })

  it('runs an app chord pressed in the editor and keeps the editor from seeing it', async () => {
    const ran = vi.fn()
    commands.register({ id: 'palette.toggle', title: 'Palette', run: ran })
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'one' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/src/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    const stopPropagation = vi.fn()
    const browserEvent = new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true })
    for (const listener of fake.state.keyListeners) listener({ browserEvent, stopPropagation })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    commands.unregister('palette.toggle')
  })

  it('adds a context-menu action that opens the send panel with the file and range', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'one\ntwo\nthree' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/src/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    select(2, 1, 3, 6)

    const action = fake.state.actions.find((a) => a.id === 'ostia.sendSelection')
    expect(action?.label).toBe('Send Selection to Agent')
    act(() => action?.run())

    const panel = await screen.findByRole('region', { name: 'Send to agent' })
    expect(panel).toHaveTextContent('a.ts:2:1-3:6')
    expect(panel).toHaveTextContent('agent shell')
    await userEvent.type(screen.getByLabelText('Note for the agent'), 'why two?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(window.ostia.selection.send).toHaveBeenCalledWith({
        capture: {
          kind: 'text',
          file: '/w/src/a.ts',
          view: 'source',
          range: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 6 },
          text: 'two\nthree',
        },
        sourcePaneId: 'p1',
        targetPaneId: TARGET_PANE,
        note: 'why two?',
      }),
    )
    expect(await screen.findByText(/Sent to agent shell/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Send to agent' })).toBeNull()
  })

  it('answers the palette command for its pane and says so when nothing is selected', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, text: 'text' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())

    act(() => {
      expect(openSelectionSend('p1')).toBe(true)
    })

    expect(await screen.findByText('Select some text first.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Send to agent' })).toBeNull()
  })

  it('sends the Markdown preview selection with its source lines', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({
      ok: true,
      text: '# Title\n\nBody text here',
    })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/README.md" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Preview Markdown' }))
    const body = await screen.findByText('Body text here')

    const range = document.createRange()
    range.setStart(body.firstChild as Node, 0)
    range.setEnd(body.firstChild as Node, 4)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    await userEvent.click(screen.getByRole('button', { name: 'Send selected text to agent' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(window.ostia.selection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          capture: {
            kind: 'text',
            file: '/w/README.md',
            view: 'preview',
            range: { startLine: 3, endLine: 3 },
            text: 'Body',
          },
        }),
      ),
    )
  })
})
