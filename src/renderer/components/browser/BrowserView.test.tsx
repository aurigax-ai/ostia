import type { PickCapture, PickOutcome, PickState } from '@shared/browser/pick'
import type { RegionCapture } from '@shared/browser/regionCapture'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { copyPaneSelection } from '@/lib/agents/selectionCopiers'
import { openSelectionSend } from '@/lib/agents/selectionSenders'
import { browserPaneOfGuest, runBrowserAction } from '@/lib/browser/browserHandles'
import { startRegionCapture } from '@/lib/browser/regionCaptures'
import { resetIds } from '@/lib/layout/tree'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRecencyStore } from '@/stores/workspaces/paneRecencyStore'
import { focusSurfaceWhenReady } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { runAgentIn } from '../../../../test/mocks/agentPanes'
import { renderSettled } from '../../../../test/render'
import { BrowserView } from './BrowserView'

function homeWorkspaceId(): string {
  if (useWorkspacesStore.getState().workspaces.length === 0)
    useWorkspacesStore.getState().addWorkspace()
  return useWorkspacesStore.getState().workspaces[0].id
}

const BROWSER = 'browser-pane'

const capture: PickCapture = {
  id: 'pick-7',
  url: 'http://localhost/',
  title: 'App',
  selector: '#save',
  label: 'button#save 80×24',
  html: '<button id="save">Save</button>',
  htmlTruncated: false,
  box: { x: 0, y: 0, width: 80, height: 24 },
  styles: {},
  role: 'button',
  name: 'Save',
  viewport: { width: 800, height: 600 },
  hasText: true,
  table: null,
  consoleErrors: [],
  failedRequests: [],
  screenshotPath: null,
  capturedAt: '2026-09-28T00:00:00.000Z',
}

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let recencyInit: ReturnType<typeof usePaneRecencyStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  attentionInit = useAttentionStore.getState()
  recencyInit = usePaneRecencyStore.getState()
})

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

let stopAgents: () => void = () => {}

afterEach(() => {
  cleanup()
  stopAgents()
  stopAgents = () => {}
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useAttentionStore.setState(attentionInit, true)
  usePaneRecencyStore.setState(recencyInit, true)
  resetIds()
  vi.restoreAllMocks()
})

function twoTerminals(): { workspaceId: string; a: string; b: string } {
  const workspaceId = homeWorkspaceId()
  useLayoutStore.getState().ensure(workspaceId)
  const a = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  useLayoutStore.getState().split(workspaceId, a, 'horizontal')
  const b = useLayoutStore.getState().byWorkspace[workspaceId].activePaneId
  stopAgents = runAgentIn([a, b])
  return { workspaceId, a, b }
}

function renderView(workspaceId: string) {
  return renderSettled(
    <TooltipProvider>
      <BrowserView
        workspaceId={workspaceId}
        paneId={BROWSER}
        url="http://localhost/"
        profile="isolated"
      />
    </TooltipProvider>,
  )
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const pickButton = () => screen.getByRole('button', { name: /point at element|stop pointing/i })

describe('BrowserView pick toggle', () => {
  it('starts a pick for this pane with the app theme and shows it as pressed', async () => {
    const { workspaceId } = twoTerminals()
    const pending = deferred<PickOutcome>()
    vi.mocked(window.ostia.browser.pickStart).mockReturnValue(pending.promise)
    await renderView(workspaceId)
    expect(pickButton()).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pickButton())
    expect(window.ostia.browser.pickStart).toHaveBeenCalledWith(
      BROWSER,
      expect.objectContaining({ accent: expect.any(String), surface: expect.any(String) }),
    )
    expect(pickButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/click an element to capture it/i)).toBeInTheDocument()
    await act(async () => pending.resolve({ ok: false, error: 'cancelled' }))
  })

  it('cancels the running pick when toggled off', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.ostia.browser.pickStart).mockReturnValue(new Promise(() => {}))
    await renderView(workspaceId)
    await userEvent.click(pickButton())
    await userEvent.click(pickButton())
    expect(window.ostia.browser.pickCancel).toHaveBeenCalledWith(BROWSER)
  })

  it('shows the agent prompt when an agent started the pick', async () => {
    const { workspaceId } = twoTerminals()
    let emit: (s: PickState) => void = () => {}
    vi.mocked(window.ostia.browser.onPickState).mockImplementation((cb) => {
      emit = cb
      return () => {}
    })
    await renderView(workspaceId)
    act(() => emit({ paneId: 'other-pane', active: true, byAgent: true }))
    expect(pickButton()).toHaveAttribute('aria-pressed', 'false')
    act(() => emit({ paneId: BROWSER, active: true, byAgent: true }))
    expect(pickButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/an agent asked you to point at an element/i)).toBeInTheDocument()
    act(() => emit({ paneId: BROWSER, active: false, byAgent: true }))
    expect(pickButton()).toHaveAttribute('aria-pressed', 'false')
  })

  it('reports a failed pick instead of failing silently', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.ostia.browser.pickStart).mockResolvedValue({ ok: false, error: 'navigated' })
    await renderView(workspaceId)
    await userEvent.click(pickButton())
    expect(await screen.findByText(/could not capture an element \(navigated\)/i)).toBeVisible()
  })
})

describe('BrowserView capture bar', () => {
  const bar = () => screen.getByRole('toolbar', { name: /selection actions/i })
  const noBar = () =>
    expect(screen.queryByRole('toolbar', { name: /selection actions/i })).toBeNull()

  async function capturedBar() {
    const panes = twoTerminals()
    usePaneRecencyStore.getState().touch(panes.a, 100)
    usePaneRecencyStore.getState().touch(panes.b, 50)
    vi.mocked(window.ostia.browser.pickStart).mockResolvedValue({ ok: true, capture })
    await renderView(panes.workspaceId)
    await userEvent.click(pickButton())
    await screen.findByRole('toolbar', { name: /selection actions/i })
    return panes
  }

  async function sendTo(index: number) {
    await userEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    const items = await screen.findAllByRole('menuitem')
    await userEvent.click(items[index])
  }

  it('opens after a capture with Copy, Send to agent, a note and a close button', async () => {
    await capturedBar()
    expect(within(bar()).getByRole('button', { name: 'Copy' })).toBeVisible()
    expect(within(bar()).getByRole('button', { name: /send to agent/i })).toBeVisible()
    expect(within(bar()).getByRole('button', { name: /add a note/i })).toBeVisible()
    expect(within(bar()).getByRole('button', { name: /cancel/i })).toBeVisible()
  })

  it('lists the agents of the workspace and sends at once to the one picked', async () => {
    const { a, b } = await capturedBar()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1000/capture-1.md',
      imagePath: null,
    })
    await userEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(2)
    await userEvent.keyboard('{Escape}')
    await sendTo(1)
    expect(window.ostia.browser.pickSend).toHaveBeenCalledWith({
      captureId: 'pick-7',
      sourcePaneId: BROWSER,
      targetPaneId: expect.stringMatching(new RegExp(`^(${a}|${b})$`)),
      note: '',
    })
    await waitFor(() => noBar())
    expect(screen.getByText(/^Sent to .*report path is on your clipboard/)).toBeVisible()
  })

  it('sends the note typed under the bar and pastes it in front of the reference', async () => {
    await capturedBar()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1000/capture-1.md',
      imagePath: null,
    })
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /add a note/i }), 'Save overlaps')
    expect(within(bar()).getByRole('button', { name: /add a note/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await sendTo(0)
    expect(window.ostia.browser.pickSend).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Save overlaps' }),
    )
  })

  it('sends a note to the last-used agent on Ctrl+Enter', async () => {
    await capturedBar()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1000/capture-1.md',
      imagePath: null,
    })
    await userEvent.click(within(bar()).getByRole('button', { name: /add a note/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /add a note/i }),
      'look{Control>}{Enter}',
    )
    await waitFor(() =>
      expect(window.ostia.browser.pickSend).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'look' }),
      ),
    )
  })

  it('keeps the bar and shows why when sending fails', async () => {
    await capturedBar()
    vi.mocked(window.ostia.browser.pickSend).mockResolvedValue({ ok: false, error: 'write-failed' })
    await sendTo(0)
    expect(await screen.findByText(/could not send the report \(write-failed\)/i)).toBeVisible()
    expect(bar()).toBeInTheDocument()
  })

  it('copies the element report and says what was copied, then closes', async () => {
    await capturedBar()
    vi.mocked(window.ostia.browser.pickCopy).mockResolvedValue({
      ok: true,
      kind: 'table',
      rows: 5,
      columns: 4,
    })
    await userEvent.click(within(bar()).getByRole('button', { name: 'Copy' }))
    expect(window.ostia.browser.pickCopy).toHaveBeenCalledWith(BROWSER, 'pick-7')
    expect(await screen.findByText('Copied the table (5 rows × 4 columns) as CSV.')).toBeVisible()
    noBar()
  })

  it('answers Ctrl+C from the pane registry while the bar is open', async () => {
    await capturedBar()
    vi.mocked(window.ostia.browser.pickCopy).mockResolvedValue({ ok: true, kind: 'image' })
    act(() => {
      expect(copyPaneSelection(BROWSER)).toBe(true)
    })
    expect(await screen.findByText('Copied the element screenshot.')).toBeVisible()
    await waitFor(() => noBar())
    expect(copyPaneSelection(BROWSER)).toBe(false)
  })

  it('discards the capture on Escape and on its close button', async () => {
    await capturedBar()
    await userEvent.keyboard('{Escape}')
    noBar()
    vi.mocked(window.ostia.browser.pickStart).mockResolvedValue({ ok: true, capture })
    await userEvent.click(pickButton())
    await screen.findByRole('toolbar', { name: /selection actions/i })
    await userEvent.click(within(bar()).getByRole('button', { name: /cancel/i }))
    noBar()
    expect(window.ostia.browser.pickSend).not.toHaveBeenCalled()
  })

  it('opens on the page selection with Ctrl+Shift+E and sends it as page text', async () => {
    const panes = twoTerminals()
    vi.mocked(window.ostia.browser.pageSelection).mockResolvedValue({
      capture: {
        kind: 'page-text',
        url: 'http://localhost/',
        title: 'App',
        text: 'Refund pending',
      },
      box: { x: 10, y: 20, width: 100, height: 20 },
      viewport: { width: 800, height: 600 },
    })
    vi.mocked(window.ostia.selection.send).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1000/selection-1.md',
      imagePath: null,
    })
    await renderView(panes.workspaceId)
    await act(async () => {
      expect(openSelectionSend(BROWSER)).toBe(true)
    })
    await screen.findByRole('toolbar', { name: /selection actions/i })
    await sendTo(0)
    expect(window.ostia.selection.send).toHaveBeenCalledWith(
      expect.objectContaining({
        capture: {
          kind: 'page-text',
          url: 'http://localhost/',
          title: 'App',
          text: 'Refund pending',
        },
        sourcePaneId: BROWSER,
      }),
    )
  })

  it('says so when the page has no selection', async () => {
    const { workspaceId } = twoTerminals()
    await renderView(workspaceId)
    await act(async () => {
      expect(openSelectionSend(BROWSER)).toBe(true)
    })
    expect(await screen.findByText('Select some text first.')).toBeVisible()
    noBar()
  })
})

describe('BrowserView region capture', () => {
  const region: RegionCapture = {
    id: 'region-3',
    url: 'http://localhost/',
    title: 'App',
    rect: { x: 10, y: 20, width: 120, height: 80 },
    imageWidth: 120,
    imageHeight: 80,
    capturedAt: '2026-10-01T00:00:00.000Z',
  }
  const regionButton = () =>
    screen.getByRole('button', { name: /^capture region$|stop capturing region/i })
  const layer = () => screen.getByRole('application', { name: /region capture/i })

  function drag(): void {
    const el = layer()
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
      x: 0,
      y: 0,
      right: 640,
      bottom: 480,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 20, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 130, clientY: 100, pointerId: 1 })
  }

  it('enters crop mode from the toolbar and leaves it on Escape without capturing', async () => {
    const { workspaceId } = twoTerminals()
    await renderView(workspaceId)
    expect(regionButton()).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(regionButton())
    expect(regionButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/drag over the page to capture a region/i)).toBeInTheDocument()
    expect(layer()).toHaveFocus()
    fireEvent.keyDown(layer(), { key: 'Escape' })
    expect(screen.queryByRole('application', { name: /region capture/i })).toBeNull()
    expect(regionButton()).toHaveAttribute('aria-pressed', 'false')
    expect(window.ostia.browser.regionCapture).not.toHaveBeenCalled()
  })

  it('starts from the palette command only for its own pane', async () => {
    const { workspaceId } = twoTerminals()
    await renderView(workspaceId)
    expect(startRegionCapture('another-pane')).toBe(false)
    act(() => {
      expect(startRegionCapture(BROWSER)).toBe(true)
    })
    expect(layer()).toBeInTheDocument()
  })

  it('asks main to capture the dragged rectangle and offers send and copy', async () => {
    const panes = twoTerminals()
    vi.mocked(window.ostia.browser.regionCapture).mockResolvedValue({ ok: true, capture: region })
    vi.mocked(window.ostia.browser.regionSend).mockResolvedValue({
      ok: true,
      path: '/tmp/ostia-reports-1000/capture-2-localhost.md',
      imagePath: '/tmp/ostia-reports-1000/capture-2-localhost.png',
    })
    await renderView(panes.workspaceId)
    await userEvent.click(regionButton())
    drag()

    expect(window.ostia.browser.regionCapture).toHaveBeenCalledWith(BROWSER, {
      rect: { x: 10, y: 20, width: 120, height: 80 },
      view: { width: 640, height: 480 },
    })
    await screen.findByRole('toolbar', { name: /selection actions/i })
    expect(screen.queryByRole('application', { name: /region capture/i })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /send to agent/i }))
    await userEvent.click((await screen.findAllByRole('menuitem'))[0])
    await waitFor(() =>
      expect(window.ostia.browser.regionSend).toHaveBeenCalledWith({
        captureId: 'region-3',
        sourcePaneId: BROWSER,
        targetPaneId: expect.any(String),
        note: '',
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('toolbar', { name: /selection actions/i })).not.toBeInTheDocument(),
    )
  })

  it('copies the image instead of sending when asked', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.ostia.browser.regionCapture).mockResolvedValue({ ok: true, capture: region })
    await renderView(workspaceId)
    await userEvent.click(regionButton())
    drag()
    await screen.findByRole('toolbar', { name: /selection actions/i })
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(window.ostia.browser.regionCopy).toHaveBeenCalledWith(BROWSER, 'region-3')
    expect(window.ostia.browser.regionSend).not.toHaveBeenCalled()
    expect(await screen.findByText('Copied the image to the clipboard.')).toBeVisible()
  })

  it('says why when main refuses the capture', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.ostia.browser.regionCapture).mockResolvedValue({ ok: false, error: 'empty' })
    await renderView(workspaceId)
    await userEvent.click(regionButton())
    drag()
    expect(await screen.findByText(/could not capture the region \(empty\)/i)).toBeVisible()
  })
})

describe('BrowserView address bar', () => {
  const navigated = (container: HTMLElement, url: string) => {
    const webview = container.querySelector('webview') as HTMLElement
    const event = Object.assign(new Event('did-navigate'), { url, isMainFrame: true })
    act(() => {
      webview.dispatchEvent(event)
    })
  }

  const failedLoad = (container: HTMLElement, errorCode: number, isMainFrame = true) => {
    const webview = container.querySelector('webview') as HTMLElement
    const event = Object.assign(new Event('did-fail-load'), {
      errorCode,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://127.0.0.1:9/',
      isMainFrame,
    })
    act(() => {
      webview.dispatchEvent(event)
    })
  }

  it('a browser tab shows why a page failed, and clears it when a page loads', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())

    failedLoad(container, -102)

    const error = screen.getByRole('alert')
    expect(error).toHaveTextContent('This page couldn’t load')
    expect(error).toHaveTextContent('http://127.0.0.1:9/')
    expect(error).toHaveTextContent('ERR_CONNECTION_REFUSED')
    expect(screen.getByRole('textbox', { name: /address/i })).toHaveValue('http://127.0.0.1:9/')

    navigated(container, 'http://localhost/page')

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['an aborted load', -3, true],
    ['a failed frame inside the page', -102, false],
  ])('shows no failure for %s', async (_name, errorCode, isMainFrame) => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())

    failedLoad(container, errorCode, isMainFrame)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps what the user is typing when a slow page finishes loading', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await userEvent.clear(address)
    await userEvent.type(address, 'proxmox.example.com')

    navigated(container, 'about:blank')

    expect(address).toHaveValue('proxmox.example.com')
  })

  it('the address bar searches with the chosen engine template', async () => {
    const initialSettings = useSettingsStore.getState()
    useSettingsStore.setState({
      browser: {
        ...initialSettings.browser,
        searchEngine: 'custom',
        customSearchUrl: 'http://127.0.0.1:9/find?term={query}',
      },
    })
    try {
      const { workspaceId } = twoTerminals()
      const { container } = await renderView(workspaceId)
      const address = screen.getByRole('textbox', { name: /address/i })
      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      await userEvent.clear(address)
      await userEvent.type(address, 'hello ostia world{Enter}')

      const searched = 'http://127.0.0.1:9/find?term=hello%20ostia%20world'
      expect(container.querySelector('webview')).toHaveAttribute('src', searched)
      expect(address).toHaveValue(searched)
    } finally {
      act(() => {
        useSettingsStore.setState(initialSettings, true)
      })
    }
  })

  it('follows navigation when the user is not typing, and Escape restores the page address', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())

    navigated(container, 'http://localhost/docs')
    await waitFor(() => expect(address).toHaveValue('http://localhost/docs'))

    await userEvent.type(address, 'x{Escape}')
    await waitFor(() => expect(address).toHaveValue('http://localhost/docs'))
  })

  const guestReadyOn = (container: HTMLElement, url: string) => {
    const webview = container.querySelector('webview') as HTMLElement
    const guest = {
      getURL: () => url,
      loadURL: vi.fn(async () => undefined),
      getWebContentsId: () => 41,
      setZoomFactor: vi.fn(),
    }
    Object.assign(webview, guest)
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    return guest
  }

  it('loads an address entered before the page was ready when the guest kept its first page', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await userEvent.clear(address)
    await userEvent.type(address, 'http://localhost/next{Enter}')

    const guest = guestReadyOn(container, 'http://localhost/')

    expect(guest.setZoomFactor).toHaveBeenCalled()
    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost/next')
  })

  it('does not load the address again when the guest already opened it', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await userEvent.clear(address)
    await userEvent.type(address, 'http://localhost/next{Enter}')

    const guest = guestReadyOn(container, 'http://localhost/next')

    expect(guest.setZoomFactor).toHaveBeenCalled()
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('gives a page opened in the pane and an address typed into a new browser tab the same default zoom', async () => {
    const initialSettings = useSettingsStore.getState()
    useSettingsStore.setState({ browser: { ...initialSettings.browser, defaultZoom: 125 } })
    try {
      const { workspaceId } = twoTerminals()
      const opened = await renderView(workspaceId)
      await waitFor(() => expect(opened.container.querySelector('webview')).not.toBeNull())
      const page = guestReadyOn(opened.container, 'http://localhost/')
      expect(page.setZoomFactor).toHaveBeenCalledWith(1.25)
      opened.unmount()

      const tab = await renderSettled(
        <TooltipProvider>
          <BrowserView workspaceId={workspaceId} paneId={BROWSER} profile="isolated" />
        </TooltipProvider>,
      )
      const address = screen.getByRole('textbox', { name: /address/i })
      await waitFor(() => expect(tab.container.querySelector('webview')).not.toBeNull())
      await userEvent.clear(address)
      await userEvent.type(address, 'http://localhost/human{Enter}')
      const human = guestReadyOn(tab.container, 'about:blank')

      expect(human.loadURL).toHaveBeenCalledWith('http://localhost/human')
      expect(human.setZoomFactor.mock.calls).toEqual(page.setZoomFactor.mock.calls)
    } finally {
      act(() => {
        useSettingsStore.setState(initialSettings, true)
      })
    }
  })
})

describe('BrowserView storage panel', () => {
  it('opens the storage panel for this pane from the toolbar and closes it again', async () => {
    const { workspaceId } = twoTerminals()
    await renderView(workspaceId)
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show storage' }))
    expect(screen.getByRole('region', { name: 'Storage' })).toBeInTheDocument()
    expect(window.ostia.browser.storageRead).toHaveBeenCalledWith(BROWSER)
    const toggle = screen.getByRole('button', { name: 'Hide storage' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(toggle)
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument()
  })
})

describe('BrowserView profile', () => {
  function renderWith(workspaceId: string, profile: 'shared' | 'isolated') {
    return render(
      <TooltipProvider>
        <BrowserView
          workspaceId={workspaceId}
          paneId={BROWSER}
          url="about:blank"
          profile={profile}
        />
      </TooltipProvider>,
    )
  }

  afterEach(() => {
    cleanup()

    useSandboxStore.setState({ enabled: {} })
  })
  it('claims its profile from main and uses the partition main granted', async () => {
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(window.ostia.browser.claimProfile).toHaveBeenCalledWith(BROWSER, 'shared')
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'persist:ostia-browser',
    )
  })

  it('falls back to its own isolated partition when main refuses the shared profile', async () => {
    vi.mocked(window.ostia.browser.claimProfile).mockResolvedValueOnce('isolated')
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      `ostia-browser-${BROWSER}`,
    )
  })

  it('asks only for an isolated profile in a sandboxed workspace', async () => {
    useSandboxStore.setState({ enabled: { ws: true } })
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(window.ostia.browser.claimProfile).toHaveBeenCalledWith(BROWSER, 'isolated')
    expect(window.ostia.browser.claimProfile).not.toHaveBeenCalledWith(BROWSER, 'shared')
  })

  it('tells the human that storage changes reach every tab of their profile', async () => {
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Show storage' }))
    expect(screen.getByText(/every browser tab that uses it/)).toBeInTheDocument()
  })

  it('says nothing about a shared profile on an isolated pane', async () => {
    const { container } = renderWith('ws', 'isolated')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Show storage' }))
    expect(screen.queryByText(/every browser tab that uses it/)).not.toBeInTheDocument()
  })
})

describe('BrowserView keys', () => {
  async function readyGuest(container: HTMLElement) {
    const webview = container.querySelector('webview') as HTMLElement
    const guest = {
      getWebContentsId: () => 31,
      setZoomFactor: vi.fn(),
      findInPage: vi.fn(() => 1),
      stopFindInPage: vi.fn(),
      focus: vi.fn(),
      reload: vi.fn(),
      canGoBack: () => true,
      goBack: vi.fn(),
      canGoForward: () => false,
      goForward: vi.fn(),
    }
    Object.assign(webview, guest)
    await waitFor(() => {
      act(() => {
        webview.dispatchEvent(new Event('dom-ready'))
      })
      expect(browserPaneOfGuest(31)).toBe(BROWSER)
    })
    return { webview, guest }
  }

  it('runs the browser keys pressed in its toolbar and leaves forward alone without history', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    const { guest } = await readyGuest(container)
    const back = screen.getByRole('button', { name: 'Back' })
    fireEvent.keyDown(back, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('textbox', { name: /address/i })).toHaveFocus()
    fireEvent.keyDown(back, { key: 'F5', code: 'F5', ctrlKey: true })
    fireEvent.keyDown(back, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true })
    fireEvent.keyDown(back, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })
    fireEvent.keyDown(back, { key: 'ArrowRight', code: 'ArrowRight', altKey: true })
    expect(guest.reload).toHaveBeenCalledTimes(1)
    expect(guest.goBack).toHaveBeenCalledTimes(1)
    expect(guest.goForward).not.toHaveBeenCalled()
  })

  it('opens find in page, searches as you type, steps with Enter, and closes on Escape', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    const { webview, guest } = await readyGuest(container)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), {
      key: 'F',
      code: 'KeyF',
      ctrlKey: true,
      shiftKey: true,
    })
    const find = await screen.findByRole('textbox', { name: 'Find in page' })
    await waitFor(() => expect(find).toHaveFocus())
    await userEvent.type(find, 'ab')
    expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: true, findNext: true })
    act(() => {
      webview.dispatchEvent(
        Object.assign(new Event('found-in-page'), {
          result: { activeMatchOrdinal: 1, matches: 3, finalUpdate: true },
        }),
      )
    })
    expect(screen.getByText('1/3')).toBeInTheDocument()
    await userEvent.type(find, '{Shift>}{Enter}{/Shift}')
    expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: false, findNext: false })
    await userEvent.type(find, '{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Find in page' })).toBeNull()
    expect(guest.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(guest.focus).toHaveBeenCalled()
  })

  it('steps find in page with F3 in the bar and with the find-next chords from the pane', async () => {
    const initialSettings = useSettingsStore.getState()
    useSettingsStore.setState({ keybindings: { 'find.next': 'Ctrl+Alt+G' } })
    try {
      const { workspaceId } = twoTerminals()
      const { container } = await renderView(workspaceId)
      await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
      const { guest } = await readyGuest(container)
      const back = screen.getByRole('button', { name: 'Back' })
      const findNext = { key: 'g', code: 'KeyG', ctrlKey: true, altKey: true }
      fireEvent.keyDown(back, findNext)
      const find = await screen.findByRole('textbox', { name: 'Find in page' })
      await userEvent.type(find, 'ab')
      guest.findInPage.mockClear()
      await userEvent.type(find, '{F3}')
      expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: true, findNext: false })
      await userEvent.type(find, '{Shift>}{F3}{/Shift}')
      expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: false, findNext: false })
      fireEvent.keyDown(back, findNext)
      expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: true, findNext: false })
      act(() => {
        runBrowserAction(BROWSER, 'findPrevious')
      })
      expect(guest.findInPage).toHaveBeenLastCalledWith('ab', { forward: false, findNext: false })
      expect(guest.findInPage).toHaveBeenCalledTimes(4)
    } finally {
      act(() => {
        useSettingsStore.setState(initialSettings, true)
      })
    }
  })

  it('lets main find the pane of its guest', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    await readyGuest(container)
    expect(browserPaneOfGuest(31)).toBe(BROWSER)
    expect(browserPaneOfGuest(32)).toBeNull()
  })
})

describe('BrowserView keyboard focus', () => {
  function guestComesUp(container: HTMLElement) {
    const webview = container.querySelector('webview') as HTMLElement
    const guest = {
      getWebContentsId: () => 41,
      getURL: () => 'about:blank',
      setZoomFactor: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      focus: vi.fn(),
    }
    Object.assign(webview, guest)
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'))
    })
    return guest
  }

  async function blankTab() {
    const { workspaceId } = twoTerminals()
    const { container } = await renderSettled(
      <TooltipProvider>
        <BrowserView workspaceId={workspaceId} paneId={BROWSER} profile="isolated" />
      </TooltipProvider>,
    )
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    act(() => focusSurfaceWhenReady(BROWSER, () => true))
    return container
  }

  it('puts the keyboard in the address bar of a new blank tab before its page is ready, and keeps it there', async () => {
    const container = await blankTab()
    const address = screen.getByRole('textbox', { name: /address/i })
    expect(address).toHaveFocus()

    const guest = guestComesUp(container)

    expect(guest.focus).not.toHaveBeenCalled()
    expect(address).toHaveFocus()
  })

  it('shows a blank tab as an empty address field, so what the human types is the whole address', async () => {
    const container = await blankTab()
    const address = screen.getByRole('textbox', { name: /address/i })
    expect(address).toHaveValue('')
    expect(address).toHaveAttribute('placeholder', 'Search or enter address')

    await userEvent.keyboard('example.com{Enter}')
    const guest = guestComesUp(container)

    expect(guest.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('gives the keyboard to the page of a tab that has one once it is ready', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = await renderView(workspaceId)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    act(() => focusSurfaceWhenReady(BROWSER, () => true))
    expect(screen.getByRole('textbox', { name: /address/i })).not.toHaveFocus()

    const guest = guestComesUp(container)

    expect(guest.focus).toHaveBeenCalled()
  })
})
