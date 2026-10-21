import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { LIVE_TEXT_DEBOUNCE_MS } from './liveDocument'
import { useLiveDocumentText } from './useLiveDocumentText'

interface FakeModel {
  uri: { toString: () => string }
  text: string
  dirty: boolean
  disposed: boolean
  listeners: Set<() => void>
  getValue: () => string
  isDisposed: () => boolean
  onDidChangeContent: (listener: () => void) => { dispose: () => void }
}

const models = vi.hoisted(() => new Map<string, unknown>())
const created = vi.hoisted(() => ({ listeners: new Set<(model: unknown) => void>() }))

vi.mock('@/lib/monaco/setup', () => ({
  monaco: {
    editor: {
      getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
      onDidCreateModel: (listener: (model: unknown) => void) => {
        created.listeners.add(listener)
        return { dispose: () => created.listeners.delete(listener) }
      },
    },
  },
}))
vi.mock('./editorModels', () => ({
  uriFor: (path: string) => ({ toString: () => `file://${path}` }),
  isDirty: (model: FakeModel) => model.dirty,
}))

const PATH = '/w/README.md'

function model(text: string, dirty: boolean): FakeModel {
  const listeners = new Set<() => void>()
  const made: FakeModel = {
    uri: { toString: () => `file://${PATH}` },
    text,
    dirty,
    disposed: false,
    listeners,
    getValue: () => made.text,
    isDisposed: () => made.disposed,
    onDidChangeContent: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
  models.set(made.uri.toString(), made)
  return made
}

function type(made: FakeModel, text: string): void {
  made.text = text
  made.dirty = true
  for (const listener of made.listeners) listener()
}

beforeEach(() => {
  vi.useFakeTimers()
  models.clear()
  created.listeners.clear()
  useEditorStatus.setState({ dirty: {}, disk: {} })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useLiveDocumentText', () => {
  it('sends the dirty text at once, then each change once typing pauses', async () => {
    const made = model('saved', true)
    renderHook(() => useLiveDocumentText('p1', PATH, true))
    await act(async () => {})
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenLastCalledWith({
      paneId: 'p1',
      path: PATH,
      text: 'saved',
    })
    vi.mocked(window.ostia.viewers.sendDocumentText).mockClear()

    act(() => type(made, 'a'))
    act(() => type(made, 'ab'))
    expect(window.ostia.viewers.sendDocumentText).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(LIVE_TEXT_DEBOUNCE_MS)
    })
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenCalledTimes(1)
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenCalledWith({
      paneId: 'p1',
      path: PATH,
      text: 'ab',
    })
  })

  it('sends null when the model is clean, when it is saved, and when the preview closes', async () => {
    const made = model('saved', false)
    const { unmount } = renderHook(() => useLiveDocumentText('p1', PATH, true))
    await act(async () => {})
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenLastCalledWith({
      paneId: 'p1',
      path: PATH,
      text: null,
    })
    act(() => type(made, 'edited'))
    act(() => {
      vi.advanceTimersByTime(LIVE_TEXT_DEBOUNCE_MS)
    })
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenLastCalledWith({
      paneId: 'p1',
      path: PATH,
      text: 'edited',
    })
    made.dirty = false
    act(() => useEditorStatus.getState().setDirty(PATH, true))
    act(() => useEditorStatus.getState().setDirty(PATH, false))
    act(() => {
      vi.advanceTimersByTime(LIVE_TEXT_DEBOUNCE_MS)
    })
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenLastCalledWith({
      paneId: 'p1',
      path: PATH,
      text: null,
    })
    vi.mocked(window.ostia.viewers.sendDocumentText).mockClear()
    unmount()
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenCalledWith({
      paneId: 'p1',
      path: PATH,
      text: null,
    })
  })

  it('sends nothing before the viewer is open and follows a model created later', async () => {
    const { rerender } = renderHook(({ on }) => useLiveDocumentText('p1', PATH, on), {
      initialProps: { on: false },
    })
    expect(window.ostia.viewers.sendDocumentText).not.toHaveBeenCalled()
    rerender({ on: true })
    await act(async () => {})
    const made = model('late', true)
    act(() => {
      for (const listener of created.listeners) listener(made)
      vi.advanceTimersByTime(LIVE_TEXT_DEBOUNCE_MS)
    })
    expect(window.ostia.viewers.sendDocumentText).toHaveBeenLastCalledWith({
      paneId: 'p1',
      path: PATH,
      text: 'late',
    })
  })
})
