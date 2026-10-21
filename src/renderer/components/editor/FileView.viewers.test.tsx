import '@testing-library/jest-dom/vitest'
import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/lib/layout/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  focusSurfaceWhenReady,
  mountSurface,
  releaseSurfaces,
  surfaceHost,
} from '@/stores/workspaces/surfaceSlotsStore'

vi.mock('./Editor', () => ({
  EditorView: ({ filePath }: { filePath?: string }) => (
    <div data-testid="editor-view">{filePath}</div>
  ),
}))

const { FileView } = await import('./FileView')

const extInit = useExtensionsStore.getState()
const layoutInit = useLayoutStore.getState()
const settingsInit = useSettingsStore.getState()

const OFFICE = {
  id: 'office',
  name: 'Office',
  builtin: true,
  enabled: true,
  fileKinds: [
    {
      id: 'office.spreadsheet',
      displayName: 'Spreadsheet',
      selector: [{ filenamePattern: '*.xlsx' }],
      view: { priority: 'default' },
      approved: true,
    },
  ],
} as unknown as ExtensionInfo

const PANE: PaneNode = {
  type: 'pane',
  id: 'p1',
  title: 'report.xlsx',
  kind: 'editor',
  filePath: '/w/report.xlsx',
}

function seed(extensions: ExtensionInfo[], pane: PaneNode = PANE): void {
  useExtensionsStore.setState({ list: extensions })
  useLayoutStore.setState({
    byWorkspace: { w: { root: pane, activePaneId: pane.id, zoomedPaneId: null } },
  })
}

function show(path = '/w/report.xlsx') {
  return render(<FileView workspaceId="w" paneId="p1" filePath={path} />)
}

beforeEach(() => {
  vi.mocked(window.ostia.viewers.open).mockResolvedValue({
    ok: true,
    src: 'ostia-viewer://t1/sheet.html',
    partition: 'ostia-viewer-office',
  })
})

afterEach(() => {
  cleanup()
  useExtensionsStore.setState(extInit, true)
  useLayoutStore.setState(layoutInit, true)
  useSettingsStore.setState(settingsInit, true)
  useOpenWithStore.setState({ paneId: null })
  vi.mocked(window.ostia.viewers.open).mockReset()
  vi.mocked(window.ostia.viewers.close).mockReset()
  vi.mocked(window.ostia.viewers.onStopped).mockReset()
  vi.mocked(window.ostia.viewers.onStopped).mockImplementation(() => () => {})
})

describe('FileView', () => {
  it('opens a file in the default viewer an enabled extension contributes', async () => {
    seed([OFFICE])
    const view = show()
    const frame = await screen.findByTestId('file-viewer')
    expect(frame).toHaveAttribute('data-view-type', 'office.spreadsheet')
    expect(window.ostia.viewers.open).toHaveBeenCalledWith({
      workspaceId: 'w',
      paneId: 'p1',
      path: '/w/report.xlsx',
      viewType: 'office.spreadsheet',
    })
    const webview = await waitFor(() => {
      const found = frame.querySelector('webview')
      if (!found) throw new Error('no webview')
      return found
    })
    expect(webview).toHaveAttribute('src', 'ostia-viewer://t1/sheet.html')
    expect(webview).toHaveAttribute('partition', 'ostia-viewer-office')
    view.unmount()
    expect(window.ostia.viewers.close).toHaveBeenCalledWith('p1')
  })

  it('says why main stopped the viewer, or that its process ended, and reloads it on click', async () => {
    let stopped: ((event: { paneId: string; reason: 'memory' | 'unresponsive' }) => void) | null =
      null
    vi.mocked(window.ostia.viewers.onStopped).mockImplementation((cb) => {
      stopped = cb
      return () => {}
    })
    seed([OFFICE])
    show()
    const frame = await screen.findByTestId('file-viewer')
    const webview = await waitFor(() => {
      const found = frame.querySelector('webview')
      if (!found) throw new Error('no webview')
      return found
    })
    act(() => {
      webview.dispatchEvent(new Event('render-process-gone'))
    })
    expect(screen.getByTestId('viewer-stopped')).toHaveTextContent('this viewer’s process ended')
    act(() => stopped?.({ paneId: 'p1', reason: 'memory' }))
    expect(screen.getByTestId('viewer-stopped')).toHaveTextContent('more than 1 GiB of memory')
    act(() => stopped?.({ paneId: 'other', reason: 'unresponsive' }))
    expect(screen.getByTestId('viewer-stopped')).toHaveTextContent('more than 1 GiB of memory')
    expect(screen.queryByTestId('editor-view')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(window.ostia.viewers.open).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('viewer-stopped')).toBeNull()
  })

  it('shows the source when no viewer matches or the extension is disabled', () => {
    seed([{ ...OFFICE, enabled: false }])
    show()
    expect(screen.getByTestId('editor-view')).toHaveTextContent('/w/report.xlsx')
    expect(window.ostia.viewers.open).not.toHaveBeenCalled()
  })

  it('falls back to the source with a note when the viewer cannot open the file', async () => {
    vi.mocked(window.ostia.viewers.open).mockResolvedValue({ ok: false, error: 'denied' })
    seed([OFFICE])
    show()
    expect(await screen.findByTestId('editor-view')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Spreadsheet could not show this file, so it opens in the editor.',
    )
  })

  it('says when the viewer chosen for the pane is gone', () => {
    seed([], { ...PANE, viewType: 'office.spreadsheet' })
    show()
    expect(screen.getByTestId('editor-view')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('not available')
    expect(screen.queryByRole('button', { name: 'Open With…' })).toBeNull()
    cleanup()
    seed([{ ...OFFICE, fileKinds: [{ ...OFFICE.fileKinds[0], id: 'office.other' }] }], {
      ...PANE,
      viewType: 'office.spreadsheet',
    })
    show()
    expect(screen.getByRole('status')).toHaveTextContent(
      'The viewer chosen for this file is not available',
    )
  })

  it('switches to the source through Open With and can remember it for the file type', async () => {
    seed([OFFICE])
    show()
    await screen.findByTestId('file-viewer')
    act(() => useOpenWithStore.getState().open('p1'))
    await userEvent.click(await screen.findByRole('radio', { name: 'Text editor' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Always use for *.xlsx files' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.getByTestId('editor-view')).toBeInTheDocument())
    const root = useLayoutStore.getState().byWorkspace.w.root as PaneNode
    expect(root.viewType).toBe('default')
    expect(useSettingsStore.getState().files.viewerAssociations).toEqual({ '*.xlsx': 'default' })
    act(() => useOpenWithStore.getState().open('p1'))
    expect(await screen.findByRole('radio', { name: 'Text editor' })).toBeChecked()
  })

  it('gives the keyboard to the viewer only once its guest is ready', async () => {
    seed([OFFICE])
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    mountSurface('p1', slot)
    render(<FileView workspaceId="w" paneId="p1" filePath="/w/report.xlsx" />, {
      container: surfaceHost('p1'),
    })
    const webview = await waitFor(() => {
      const found = surfaceHost('p1').querySelector<HTMLElement>('webview')
      if (!found) throw new Error('no webview yet')
      return found
    })
    webview.tabIndex = 0
    focusSurfaceWhenReady('p1', () => true)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve)))
    expect(document.activeElement).not.toBe(webview)
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    await waitFor(() => expect(document.activeElement).toBe(webview))
    cleanup()
    releaseSurfaces(new Set())
    slot.remove()
  })
})
