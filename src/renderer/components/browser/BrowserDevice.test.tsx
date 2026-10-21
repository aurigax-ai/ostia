import { DEFAULT_DEVICE } from '@shared/browser/browserDevice'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { findPane, resetIds } from '@/lib/layout/tree'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { renderSettled } from '../../../../test/render'
import { BrowserView } from './BrowserView'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  cleanup()
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  resetIds()
  vi.restoreAllMocks()
})

function browserPane(): { workspaceId: string; paneId: string } {
  useWorkspacesStore.getState().addWorkspace()
  const workspaceId = useWorkspacesStore.getState().workspaces[0].id
  useLayoutStore.getState().ensure(workspaceId)
  const first = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  useLayoutStore.getState().newTab(workspaceId, first, 'browser')
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  return { workspaceId, paneId }
}

function savedDevice(workspaceId: string, paneId: string) {
  return findPane(useLayoutStore.getState().byWorkspace[workspaceId].root, paneId)?.browserDevice
}

function Pane({ workspaceId, paneId }: { workspaceId: string; paneId: string }): JSX.Element {
  const device = useLayoutStore(
    (s) => findPane(s.byWorkspace[workspaceId].root, paneId)?.browserDevice,
  )
  return (
    <TooltipProvider>
      <BrowserView
        workspaceId={workspaceId}
        paneId={paneId}
        url="http://localhost/"
        profile="isolated"
        device={device}
      />
    </TooltipProvider>
  )
}

function guestReady(container: HTMLElement): void {
  const webview = container.querySelector('webview') as HTMLElement
  Object.assign(webview, {
    getURL: () => 'http://localhost/',
    loadURL: vi.fn(async () => undefined),
    getWebContentsId: () => 41,
    setZoomFactor: vi.fn(),
  })
  act(() => {
    webview.dispatchEvent(new Event('dom-ready'))
  })
}

const deviceButton = () => screen.getByRole('button', { name: /^device mode$|exit device mode/i })
const deviceBar = () => screen.queryByRole('toolbar', { name: 'Device mode settings' })

describe('BrowserView device mode', () => {
  it('turns on from the toolbar, saves the device on the pane and tells main once the page is ready', async () => {
    const { workspaceId, paneId } = browserPane()
    const { container } = await renderSettled(<Pane workspaceId={workspaceId} paneId={paneId} />)
    expect(deviceButton()).toHaveAttribute('aria-pressed', 'false')
    expect(deviceBar()).toBeNull()
    await userEvent.click(deviceButton())
    expect(deviceButton()).toHaveAttribute('aria-pressed', 'true')
    expect(deviceBar()).toBeInTheDocument()
    expect(savedDevice(workspaceId, paneId)).toEqual(DEFAULT_DEVICE)
    expect(window.ostia.browser.setDevice).not.toHaveBeenCalled()
    guestReady(container)
    expect(window.ostia.browser.setDevice).toHaveBeenCalledWith(paneId, DEFAULT_DEVICE)
  })

  it('tells main nothing for a pane that never used device mode', async () => {
    const { workspaceId, paneId } = browserPane()
    const { container } = await renderSettled(<Pane workspaceId={workspaceId} paneId={paneId} />)
    guestReady(container)
    expect(window.ostia.browser.setDevice).not.toHaveBeenCalled()
  })

  it('rotates, resizes from the width field and turns off, sending each change', async () => {
    const { workspaceId, paneId } = browserPane()
    useLayoutStore.getState().setBrowserDevice(workspaceId, paneId, DEFAULT_DEVICE)
    const { container } = await renderSettled(<Pane workspaceId={workspaceId} paneId={paneId} />)
    guestReady(container)
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(savedDevice(workspaceId, paneId)).toMatchObject({ width: 800, height: 400 })
    const width = screen.getByRole('spinbutton', { name: 'Width' })
    await userEvent.clear(width)
    await userEvent.type(width, '1200{Enter}')
    expect(savedDevice(workspaceId, paneId)).toMatchObject({ width: 1200, height: 400 })
    expect(window.ostia.browser.setDevice).toHaveBeenLastCalledWith(
      paneId,
      expect.objectContaining({ width: 1200, height: 400 }),
    )
    await userEvent.click(deviceButton())
    expect(deviceBar()).toBeNull()
    expect(savedDevice(workspaceId, paneId)).toBeUndefined()
    expect(window.ostia.browser.setDevice).toHaveBeenLastCalledWith(paneId, null)
  })

  it('keeps the page’s own element when device mode goes on and off', async () => {
    const { workspaceId, paneId } = browserPane()
    const { container } = await renderSettled(<Pane workspaceId={workspaceId} paneId={paneId} />)
    const webview = container.querySelector('webview')
    await userEvent.click(deviceButton())
    expect(container.querySelector('webview')).toBe(webview)
    await userEvent.click(deviceButton())
    expect(container.querySelector('webview')).toBe(webview)
  })

  it('resizes a responsive device from its edge handle and saves the size when the drag ends', async () => {
    const { workspaceId, paneId } = browserPane()
    useLayoutStore.getState().setBrowserDevice(workspaceId, paneId, DEFAULT_DEVICE)
    const { container } = await renderSettled(<Pane workspaceId={workspaceId} paneId={paneId} />)
    const handle = container.querySelector('[data-edge="bottom"]') as HTMLElement
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 30, pointerId: 1 })
    expect(screen.getByRole('spinbutton', { name: 'Height' })).toHaveValue(830)
    expect(savedDevice(workspaceId, paneId)).toEqual(DEFAULT_DEVICE)
    fireEvent.pointerUp(handle, { clientX: 0, clientY: 40, pointerId: 1 })
    expect(savedDevice(workspaceId, paneId)).toMatchObject({ width: 400, height: 830 })
  })
})
