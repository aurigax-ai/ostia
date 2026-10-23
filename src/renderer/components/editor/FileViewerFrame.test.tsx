import '@testing-library/jest-dom/vitest'
import type { ViewerCopied, ViewerOpenLink, ViewerSelectionEvent } from '@shared/files/filesApi'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeCapture,
  copyCapture,
  triggerCapture,
  useCaptureStore,
} from '@/lib/capture/captureSession'
import { useViewerHintStore } from '@/stores/files/viewerHintStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { FileViewerFrame } from './FileViewerFrame'

const openFile = vi.fn()
const openBrowserTabAs = vi.fn()

vi.mock('@/lib/browser/browserProfile', () => ({
  openBrowserTabAs: (...args: unknown[]) => openBrowserTabAs(...args),
}))
const paneVisible = { value: true }

vi.mock('./useLiveDocumentText', () => ({ useLiveDocumentText: () => {} }))

vi.mock('@/lib/attention/workspaceActivity', () => ({
  usePaneVisible: () => paneVisible.value,
}))
const layoutInit = useLayoutStore.getState()

type Listener<T> = (event: T) => void
let onSelection: Listener<ViewerSelectionEvent>
let onCopied: Listener<ViewerCopied>
let onOpenLink: Listener<ViewerOpenLink>
let onEditSource: Listener<{ paneId: string }>

const SELECTION: ViewerSelectionEvent['selection'] = {
  capture: {
    kind: 'image',
    file: '/w/a.png',
    imageWidth: 10,
    imageHeight: 10,
    region: { x: 1, y: 1, width: 4, height: 4 },
  },
  hasImage: true,
  hasText: false,
  anchor: { left: 12, top: 30, bottom: 60 },
  seq: 1,
}

function mount(): void {
  render(
    <FileViewerFrame
      workspaceId="w"
      paneId="p1"
      filePath="/w/a.png"
      viewer={{ viewType: 'images.image', displayName: 'Images', priority: 'default' } as never}
      onFailed={() => {}}
    />,
  )
}

beforeEach(() => {
  vi.mocked(window.ostia.viewers.open).mockResolvedValue({
    ok: true,
    src: 'ostia-viewer://t/',
    partition: 'ostia-viewer-images',
  } as never)
  vi.mocked(window.ostia.viewers.onSelection).mockImplementation((cb) => {
    onSelection = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.onCopied).mockImplementation((cb) => {
    onCopied = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.onOpenLink).mockImplementation((cb) => {
    onOpenLink = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.onEditSource).mockImplementation((cb) => {
    onEditSource = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.copySelection).mockClear()
  vi.mocked(window.ostia.viewers.clearSelection).mockClear()
  paneVisible.value = true
  openFile.mockClear()
  useLayoutStore.setState({ openFile } as never)
  openBrowserTabAs.mockClear()
})

afterEach(() => {
  cleanup()
  closeCapture('p1', 'source-gone')
  useLayoutStore.setState(layoutInit, true)
})

describe('FileViewerFrame', () => {
  it('opens the page with the hint a search left for this file, once', async () => {
    useViewerHintStore.getState().request('/w/a.png', 'page=3&find=needle')
    mount()
    await act(async () => {})
    expect(document.querySelector('webview')?.getAttribute('src')).toBe(
      'ostia-viewer://t/#page=3&find=needle&n=0',
    )
    expect(useViewerHintStore.getState().pending).toEqual({})
  })

  it('takes a hint that arrives while the page is open, once, and not again on a reload', async () => {
    mount()
    await act(async () => {})
    const src = (): string | null | undefined =>
      document.querySelector('webview')?.getAttribute('src')
    expect(src()).toBe('ostia-viewer://t/')
    act(() => useViewerHintStore.getState().request('/w/a.png', 'page=4&find=second'))
    expect(src()).toBe('ostia-viewer://t/#page=4&find=second&n=1')
    expect(useViewerHintStore.getState().pending).toEqual({})
    act(() => useViewerHintStore.getState().request('/w/other.png', 'page=9'))
    expect(src()).toBe('ostia-viewer://t/#page=4&find=second&n=1')
    expect(useViewerHintStore.getState().pending).toEqual({ '/w/other.png': 'page=9' })
    useViewerHintStore.setState({ pending: {} })
    cleanup()
    mount()
    await act(async () => {})
    expect(src()).toBe('ostia-viewer://t/')
  })

  it('navigates again for the same hint clicked twice', async () => {
    mount()
    await act(async () => {})
    const src = (): string | null | undefined =>
      document.querySelector('webview')?.getAttribute('src')
    act(() => useViewerHintStore.getState().request('/w/a.png', 'page=2&find=again'))
    const first = src()
    act(() => useViewerHintStore.getState().request('/w/a.png', 'page=2&find=again'))
    expect(src()).not.toBe(first)
    expect(src()).toBe('ostia-viewer://t/#page=2&find=again&n=2')
  })

  it('leaves no hint behind for a later open when it takes one while mounted', async () => {
    mount()
    await act(async () => {})
    act(() => useViewerHintStore.getState().request('/w/a.png', 'page=2'))
    cleanup()
    mount()
    await act(async () => {})
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('ostia-viewer://t/')
  })

  it('draws no toolbar row, only the page', async () => {
    mount()
    await act(async () => {})
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.querySelector('.viewer-toolbar')).toBeNull()
  })

  const held = () => useCaptureStore.getState().open.p1

  it('opens a capture at the published anchor and drops it when the selection clears', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(held().adapter.anchor).toEqual({ left: 12, top: 30, bottom: 60 })
    act(() => onSelection({ paneId: 'p1', selection: null }))
    expect(held()).toBeUndefined()
    expect(window.ostia.viewers.clearSelection).not.toHaveBeenCalled()
  })

  it('ignores another pane’s selection', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p2', selection: SELECTION }))
    expect(held()).toBeUndefined()
  })

  it('copies through main from the bar and from the pane copier, and closes on the status', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    await act(async () => {
      await copyCapture('p1')
    })
    expect(window.ostia.viewers.copySelection).toHaveBeenCalledWith('p1')
    expect(useCaptureStore.getState().status.p1).toBe('Copied text')
    expect(held()).toBeUndefined()
    expect(window.ostia.viewers.clearSelection).toHaveBeenCalledWith('p1')
  })

  it('closes with the status main pushes when a copy chord reached the page', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    act(() => onCopied({ paneId: 'p2', status: 'Copied other' }))
    expect(held()).toBeDefined()
    act(() => onCopied({ paneId: 'p1', status: 'Copied the selection.' }))
    expect(held()).toBeUndefined()
    expect(useCaptureStore.getState().status.p1).toBe('Copied the selection.')
    expect(window.ostia.viewers.copySelection).not.toHaveBeenCalled()
  })

  it('clears the stored selection when the bar is closed, not when main dropped it', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    act(() => closeCapture('p1', 'cancel'))
    expect(window.ostia.viewers.clearSelection).toHaveBeenCalledExactlyOnceWith('p1')
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    act(() => onSelection({ paneId: 'p1', selection: null }))
    expect(window.ostia.viewers.clearSelection).toHaveBeenCalledTimes(1)
  })

  it('keeps the capture while the same numbered selection moves and replaces it for the next one without clearing main', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    const first = held().key
    act(() =>
      onSelection({
        paneId: 'p1',
        selection: SELECTION && { ...SELECTION, anchor: { left: 40, top: 50, bottom: 80 } },
      }),
    )
    expect(held().key).toBe(first)
    expect(held().adapter.anchor).toEqual({ left: 40, top: 50, bottom: 80 })
    act(() => onSelection({ paneId: 'p1', selection: SELECTION && { ...SELECTION, seq: 2 } }))
    expect(held().key).not.toBe(first)
    expect(window.ostia.viewers.clearSelection).not.toHaveBeenCalled()
  })

  it('closes the capture when its pane is hidden', async () => {
    paneVisible.value = false
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    await act(async () => {})
    expect(held()).toBeUndefined()
    expect(window.ostia.viewers.clearSelection).toHaveBeenCalledWith('p1')
  })

  it('lets the bar take focus only when the page held it as the selection arrived', async () => {
    mount()
    await act(async () => {})
    const webview = document.querySelector('webview')
    const active = vi.spyOn(document, 'activeElement', 'get')
    active.mockReturnValue(document.body)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(held().adapter.takeFocus).toBe(false)
    active.mockReturnValue(webview)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION && { ...SELECTION, seq: 2 } }))
    expect(held().adapter.takeFocus).toBe(true)
    active.mockRestore()
  })

  it('answers the pane send chord by asking the bar for its Send menu while a selection exists', async () => {
    mount()
    await act(async () => {})
    expect(triggerCapture('p1')).toBe(false)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(held().sendRequest).toBe(0)
    act(() => {
      expect(triggerCapture('p1')).toBe(true)
    })
    expect(held().sendRequest).toBe(1)
    act(() => onSelection({ paneId: 'p1', selection: null }))
    expect(triggerCapture('p1')).toBe(false)
  })

  it('opens a web link in a browser tab, a mail link outside and a file in the frame’s own workspace', async () => {
    mount()
    await act(async () => {})
    act(() =>
      onOpenLink({
        paneId: 'p1',
        target: { kind: 'url', href: 'https://example.com/', shift: false },
      }),
    )
    expect(openBrowserTabAs).toHaveBeenCalledWith('w', 'https://example.com/', 'human')
    act(() =>
      onOpenLink({
        paneId: 'p1',
        target: { kind: 'url', href: 'https://example.com/b', shift: true },
      }),
    )
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith('https://example.com/b')
    act(() =>
      onOpenLink({ paneId: 'p1', target: { kind: 'url', href: 'mailto:a@b.c', shift: false } }),
    )
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith('mailto:a@b.c')
    act(() => onOpenLink({ paneId: 'p1', target: { kind: 'file', path: '/w/notes.md' } }))
    expect(openFile).toHaveBeenCalledWith('w', '/w/notes.md')
  })

  it('switches the pane back to the editor on an edit-source request', async () => {
    const setViewType = vi.fn()
    useLayoutStore.setState({ setViewType } as never)
    mount()
    await act(async () => {})
    act(() => onEditSource({ paneId: 'p1' }))
    expect(setViewType).toHaveBeenCalledWith('w', 'p1', 'default')
    act(() => onEditSource({ paneId: 'p2' }))
    expect(setViewType).toHaveBeenCalledTimes(1)
  })
})
