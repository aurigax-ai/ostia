import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TARGET_PANE, seedSendTarget } from '../../../test/mocks/sendTarget'
import { openSelectionSend } from '../lib/selectionSenders'
import { useEditorStatus } from '../stores/editorStatusStore'
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
    blurListeners: Listener[]
    formatRuns: (() => void) | null
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
    blurListeners: [],
    formatRuns: null,
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
    getSelection: () => state.selection,
    updateOptions: (o: Record<string, unknown>) => {
      state.optionUpdates.push(o)
    },
    onDidChangeModelContent: (l: Listener) => listen(state.contentListeners, l),
    onDidBlurEditorText: (l: Listener) => listen(state.blurListeners, l),
    getAction: (id: string) =>
      id === 'editor.action.formatDocument' && state.formatRuns
        ? { run: async () => state.formatRuns?.() }
        : null,
    onDidChangeModel: () => ({ dispose() {} }),
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
vi.mock('../lsp/client', () => ({ openDocument: vi.fn().mockResolvedValue(undefined) }))

const { EditorView, isBinary } = await import('./Editor')

describe('EditorView', () => {
  let init: ReturnType<typeof useEditorStatus.getState>
  let initSettings: ReturnType<typeof useSettingsStore.getState>
  beforeAll(() => {
    init = useEditorStatus.getState()
    initSettings = useSettingsStore.getState()
  })
  afterEach(() => {
    fake.models.clear()
    fake.state.model = null
    fake.state.save = null
    fake.state.actions = []
    fake.state.position = null
    fake.state.formatRuns = null
    fake.state.createOptions = null
    fake.state.optionUpdates = []
    useSettingsStore.setState(initSettings, true)
    useEditorStatus.setState(init, true)
  })

  it('scrolls without smooth animation while motion is reduced', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    act(() => useSettingsStore.getState().setMotion('reduced'))
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    expect(fake.state.createOptions?.smoothScrolling).toBe(false)

    act(() => useSettingsStore.getState().setMotion('full'))
    expect(fake.state.optionUpdates.at(-1)).toEqual({ smoothScrolling: true })
  })

  it('does not overwrite a model with unsaved edits when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    act(() => fake.state.model?.setValue('my edit'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/a.txt'))

    expect(fake.state.model?.getValue()).toBe('my edit')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('refreshes a clean model from disk when the file is reopened', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v1')
    const { rerender } = render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v1'))

    vi.mocked(window.pine.fs.read).mockResolvedValue('disk v2')
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/b.txt" />)
    await waitFor(() => expect(fake.state.model?.uri.path).toBe('/w/b.txt'))
    rerender(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)

    await waitFor(() => expect(fake.state.model?.getValue()).toBe('disk v2'))
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined()
  })

  it('keeps the file dirty and shows an error when the write fails', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    vi.mocked(window.pine.fs.write).mockResolvedValue(false)
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save /w/a.txt')
    expect(useEditorStatus.getState().dirty['/w/a.txt']).toBe(true)
  })

  it('clears the dirty flag after a successful save', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
    expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed')
  })

  it('formats the document before writing when format on save is on', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    useSettingsStore.getState().setEditor({ formatOnSave: true })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('unformatted'))
    fake.state.formatRuns = () => fake.state.model?.setValue('formatted')

    act(() => fake.state.save?.())

    await waitFor(() => expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'formatted'))
    await waitFor(() => expect(useEditorStatus.getState().dirty['/w/a.txt']).toBeUndefined())
  })

  it('just saves when format on save is on but no formatter exists', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    useSettingsStore.getState().setEditor({ formatOnSave: true })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))

    act(() => fake.state.save?.())

    await waitFor(() => expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed'))
  })

  it('auto-saves one second after the last edit when auto save is afterDelay', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    useSettingsStore.getState().setEditor({ autoSave: 'afterDelay' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    vi.useFakeTimers()
    try {
      act(() => fake.state.model?.setValue('one'))
      await vi.advanceTimersByTimeAsync(600)
      act(() => fake.state.model?.setValue('two'))
      await vi.advanceTimersByTimeAsync(600)
      expect(window.pine.fs.write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      expect(window.pine.fs.write).toHaveBeenCalledTimes(1)
      expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'two')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-save on a timer when auto save is off', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    vi.useFakeTimers()
    try {
      act(() => fake.state.model?.setValue('one'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(window.pine.fs.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-saves a dirty file when the editor loses focus and auto save is onFocusChange', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    useSettingsStore.getState().setEditor({ autoSave: 'onFocusChange' })
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.txt" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    act(() => fake.state.model?.setValue('changed'))
    expect(window.pine.fs.write).not.toHaveBeenCalled()

    act(() => {
      for (const l of fake.state.blurListeners) l()
    })

    await waitFor(() => expect(window.pine.fs.write).toHaveBeenCalledWith('/w/a.txt', 'changed'))
  })

  it('shows a binary-file message instead of opening a file containing NUL bytes', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('PNG\0\0data')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/blob.bin" />)

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
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a b.ts" />)
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
    vi.mocked(window.pine.selection.send).mockResolvedValue({
      ok: true,
      path: '/tmp/pine-reports-1/selection-1.md',
      imagePath: null,
    })
  })
  afterEach(() => {
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

  it('adds a context-menu action that opens the send panel with the file and range', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('one\ntwo\nthree')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/src/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())
    select(2, 1, 3, 6)

    const action = fake.state.actions.find((a) => a.id === 'pine.sendSelection')
    expect(action?.label).toBe('Send Selection to Agent')
    act(() => action?.run())

    const panel = await screen.findByRole('region', { name: 'Send to agent' })
    expect(panel).toHaveTextContent('a.ts:2:1-3:6')
    expect(panel).toHaveTextContent('agent shell')
    await userEvent.type(screen.getByLabelText('Note for the agent'), 'why two?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(window.pine.selection.send).toHaveBeenCalledWith({
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
    vi.mocked(window.pine.fs.read).mockResolvedValue('text')
    render(<EditorView workspaceId="w1" paneId="p1" filePath="/w/a.ts" />)
    await waitFor(() => expect(fake.state.model).not.toBeNull())

    act(() => {
      expect(openSelectionSend('p1')).toBe(true)
    })

    expect(await screen.findByText('Select some text first.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Send to agent' })).toBeNull()
  })

  it('sends the Markdown preview selection with its source lines', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue('# Title\n\nBody text here')
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
    await userEvent.click(screen.getByRole('button', { name: 'Send Selection to Agent' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(window.pine.selection.send).toHaveBeenCalledWith(
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

describe('isBinary', () => {
  it('detects a NUL within the first 8KB only', () => {
    expect(isBinary('plain text')).toBe(false)
    expect(isBinary('a\0b')).toBe(true)
    expect(isBinary(`${'x'.repeat(8192)}\0`)).toBe(false)
  })
})
