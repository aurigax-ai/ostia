import '@testing-library/jest-dom/vitest'
import type { ViewerOpenLink, ViewerSelectionEvent } from '@shared/files/filesApi'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyPaneSelection } from '@/lib/agents/selectionCopiers'
import { openSelectionSend } from '@/lib/agents/selectionSenders'
import { useViewerHintStore } from '@/stores/files/viewerHintStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { FileViewerFrame } from './FileViewerFrame'

const openFileInWorkspace = vi.fn()
const openBrowserTabAs = vi.fn()

vi.mock('@/lib/files/openFile', () => ({
  openFileInWorkspace: (path: string) => openFileInWorkspace(path),
}))
vi.mock('@/lib/browser/browserProfile', () => ({
  openBrowserTabAs: (...args: unknown[]) => openBrowserTabAs(...args),
}))
const paneVisible = { value: true }

vi.mock('./useLiveDocumentText', () => ({ useLiveDocumentText: () => {} }))

vi.mock('@/lib/attention/workspaceActivity', () => ({
  usePaneVisible: () => paneVisible.value,
}))
vi.mock('@/components/agents/RegionActionBar', () => ({
  RegionActionBar: ({
    anchor,
    onCopy,
    onClose,
    takeFocus,
    sendRequest,
  }: {
    anchor: { left: number; top: number }
    onCopy: () => Promise<string | null>
    onClose: () => void
    takeFocus: boolean
    sendRequest: number
  }) => (
    <div
      data-testid="region-bar"
      data-left={anchor.left}
      data-top={anchor.top}
      data-take-focus={String(takeFocus)}
      data-send-request={sendRequest}
    >
      <button type="button" onClick={() => void onCopy()}>
        copy
      </button>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}))

const layoutInit = useLayoutStore.getState()

type Listener<T> = (event: T) => void
let onSelection: Listener<ViewerSelectionEvent>
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
  vi.mocked(window.ostia.viewers.onOpenLink).mockImplementation((cb) => {
    onOpenLink = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.onEditSource).mockImplementation((cb) => {
    onEditSource = cb
    return () => {}
  })
  vi.mocked(window.ostia.viewers.copySelection).mockClear()
  paneVisible.value = true
  openFileInWorkspace.mockClear()
  openBrowserTabAs.mockClear()
})

afterEach(() => {
  cleanup()
  useLayoutStore.setState(layoutInit, true)
})

describe('FileViewerFrame', () => {
  it('opens the page with the hint a search left for this file, once', async () => {
    useViewerHintStore.getState().request('/w/a.png', 'page=3&find=needle')
    mount()
    await act(async () => {})
    expect(document.querySelector('webview')?.getAttribute('src')).toBe(
      'ostia-viewer://t/#page=3&find=needle',
    )
    expect(useViewerHintStore.getState().pending).toEqual({})
  })

  it('draws no toolbar row, only the page', async () => {
    mount()
    await act(async () => {})
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(document.querySelector('.viewer-toolbar')).toBeNull()
  })

  it('shows the capture bar at the published anchor and hides it when the selection clears', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    const bar = screen.getByTestId('region-bar')
    expect(bar).toHaveAttribute('data-left', '12')
    expect(bar).toHaveAttribute('data-top', '30')
    act(() => onSelection({ paneId: 'p1', selection: null }))
    expect(screen.queryByTestId('region-bar')).toBeNull()
  })

  it('ignores another pane’s selection', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p2', selection: SELECTION }))
    expect(screen.queryByTestId('region-bar')).toBeNull()
  })

  it('copies through main from the bar and from the pane copier', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    act(() => screen.getByText('copy').click())
    expect(window.ostia.viewers.copySelection).toHaveBeenCalledWith('p1')
    expect(copyPaneSelection('p1')).toBe(true)
    expect(window.ostia.viewers.copySelection).toHaveBeenCalledTimes(2)
  })

  it('clears the stored selection when the bar is closed', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    act(() => screen.getByText('close').click())
    expect(window.ostia.viewers.clearSelection).toHaveBeenCalledWith('p1')
  })

  it('mounts a fresh bar for each numbered selection and keeps it while the same one moves', async () => {
    mount()
    await act(async () => {})
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    const first = screen.getByTestId('region-bar')
    act(() =>
      onSelection({
        paneId: 'p1',
        selection: SELECTION && { ...SELECTION, anchor: { left: 40, top: 50, bottom: 80 } },
      }),
    )
    expect(screen.getByTestId('region-bar')).toBe(first)
    expect(screen.getByTestId('region-bar')).toHaveAttribute('data-left', '40')
    act(() => onSelection({ paneId: 'p1', selection: SELECTION && { ...SELECTION, seq: 2 } }))
    expect(screen.getByTestId('region-bar')).not.toBe(first)
  })

  it('draws the bar only while its pane is shown', async () => {
    mount()
    await act(async () => {})
    paneVisible.value = false
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(screen.queryByTestId('region-bar')).toBeNull()
    paneVisible.value = true
    act(() => onSelection({ paneId: 'p1', selection: SELECTION && { ...SELECTION, seq: 2 } }))
    expect(screen.getByTestId('region-bar')).toBeInTheDocument()
  })

  it('lets the bar take focus only when the page held it as the selection arrived', async () => {
    mount()
    await act(async () => {})
    const webview = document.querySelector('webview')
    const active = vi.spyOn(document, 'activeElement', 'get')
    active.mockReturnValue(document.body)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(screen.getByTestId('region-bar')).toHaveAttribute('data-take-focus', 'false')
    active.mockReturnValue(webview)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION && { ...SELECTION, seq: 2 } }))
    expect(screen.getByTestId('region-bar')).toHaveAttribute('data-take-focus', 'true')
    active.mockRestore()
  })

  it('answers the pane send chord by asking the bar for its Send menu while a selection exists', async () => {
    mount()
    await act(async () => {})
    expect(openSelectionSend('p1')).toBe(false)
    act(() => onSelection({ paneId: 'p1', selection: SELECTION }))
    expect(screen.getByTestId('region-bar')).toHaveAttribute('data-send-request', '0')
    act(() => {
      expect(openSelectionSend('p1')).toBe(true)
    })
    expect(screen.getByTestId('region-bar')).toHaveAttribute('data-send-request', '1')
    act(() => onSelection({ paneId: 'p1', selection: null }))
    expect(openSelectionSend('p1')).toBe(false)
  })

  it('opens a web link in a browser tab, a mail link outside and a file in the workspace', async () => {
    mount()
    await act(async () => {})
    act(() => onOpenLink({ paneId: 'p1', target: { kind: 'url', href: 'https://example.com/' } }))
    expect(openBrowserTabAs).toHaveBeenCalledWith('w', 'https://example.com/', 'human')
    act(() => onOpenLink({ paneId: 'p1', target: { kind: 'url', href: 'mailto:a@b.c' } }))
    expect(window.ostia.openPath.openLink).toHaveBeenCalledWith('mailto:a@b.c')
    act(() => onOpenLink({ paneId: 'p1', target: { kind: 'file', path: '/w/notes.md' } }))
    expect(openFileInWorkspace).toHaveBeenCalledWith('/w/notes.md')
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
