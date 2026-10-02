import type { PickCapture, PickOutcome, PickState } from '@shared/pick'
import type { RegionCapture } from '@shared/regionCapture'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentIn } from '../../../test/mocks/agentPanes'
import { resetIds } from '../layout/tree'
import { startRegionCapture } from '../lib/regionCaptures'
import { useAttentionStore } from '../stores/attentionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePaneRecencyStore } from '../stores/paneRecencyStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { BrowserView } from './BrowserView'
import { TooltipProvider } from './ui/tooltip'

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
  return render(
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
    vi.mocked(window.pine.browser.pickStart).mockReturnValue(pending.promise)
    renderView(workspaceId)
    expect(pickButton()).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(pickButton())
    expect(window.pine.browser.pickStart).toHaveBeenCalledWith(
      BROWSER,
      expect.objectContaining({ accent: expect.any(String), surface: expect.any(String) }),
    )
    expect(pickButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/click an element to capture it/i)).toBeInTheDocument()
    await act(async () => pending.resolve({ ok: false, error: 'cancelled' }))
  })

  it('cancels the running pick when toggled off', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.pine.browser.pickStart).mockReturnValue(new Promise(() => {}))
    renderView(workspaceId)
    await userEvent.click(pickButton())
    await userEvent.click(pickButton())
    expect(window.pine.browser.pickCancel).toHaveBeenCalledWith(BROWSER)
  })

  it('shows the agent prompt when an agent started the pick', () => {
    const { workspaceId } = twoTerminals()
    let emit: (s: PickState) => void = () => {}
    vi.mocked(window.pine.browser.onPickState).mockImplementation((cb) => {
      emit = cb
      return () => {}
    })
    renderView(workspaceId)
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
    vi.mocked(window.pine.browser.pickStart).mockResolvedValue({ ok: false, error: 'navigated' })
    renderView(workspaceId)
    await userEvent.click(pickButton())
    expect(await screen.findByText(/could not capture an element \(navigated\)/i)).toBeVisible()
  })
})

describe('BrowserView send panel', () => {
  async function capturedPanel() {
    const panes = twoTerminals()
    usePaneRecencyStore.getState().touch(panes.a, 100)
    usePaneRecencyStore.getState().touch(panes.b, 50)
    vi.mocked(window.pine.browser.pickStart).mockResolvedValue({ ok: true, capture })
    renderView(panes.workspaceId)
    await userEvent.click(pickButton())
    await screen.findByRole('region', { name: /send to agent/i })
    return panes
  }

  it('opens after a capture with the note focused and the most recent terminal selected', async () => {
    const { a } = await capturedPanel()
    expect(screen.getByLabelText(/what’s wrong/i)).toHaveFocus()
    expect(screen.getByText('button#save 80×24')).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    const selected = screen.getByRole('radio', { checked: true }).closest('label')
    expect(selected?.htmlFor.endsWith(`-target-${a}`)).toBe(true)
  })

  it('sends the note to the chosen pane and confirms in the browser pane', async () => {
    const { b } = await capturedPanel()
    vi.mocked(window.pine.browser.pickSend).mockResolvedValue({
      ok: true,
      path: '/tmp/pine-reports-1000/capture-1.md',
      imagePath: null,
    })
    await userEvent.type(screen.getByLabelText(/what’s wrong/i), 'Save overlaps the footer')
    await userEvent.click(screen.getAllByRole('radio')[1])
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(window.pine.browser.pickSend).toHaveBeenCalledWith({
      captureId: 'pick-7',
      sourcePaneId: BROWSER,
      targetPaneId: b,
      note: 'Save overlaps the footer',
    })
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /send to agent/i })).not.toBeInTheDocument(),
    )
    expect(screen.getByText(/^Sent to .*report path is on your clipboard/)).toBeVisible()
  })

  it('keeps the panel and shows why when sending fails', async () => {
    await capturedPanel()
    vi.mocked(window.pine.browser.pickSend).mockResolvedValue({ ok: false, error: 'write-failed' })
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/could not send the report \(write-failed\)/i)).toBeVisible()
    expect(screen.getByRole('region', { name: /send to agent/i })).toBeInTheDocument()
  })

  it('discards the capture on Escape', async () => {
    await capturedPanel()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: /send to agent/i })).not.toBeInTheDocument()
    expect(window.pine.browser.pickSend).not.toHaveBeenCalled()
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
    renderView(workspaceId)
    expect(regionButton()).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(regionButton())
    expect(regionButton()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/drag over the page to capture a region/i)).toBeInTheDocument()
    expect(layer()).toHaveFocus()
    fireEvent.keyDown(layer(), { key: 'Escape' })
    expect(screen.queryByRole('application', { name: /region capture/i })).toBeNull()
    expect(regionButton()).toHaveAttribute('aria-pressed', 'false')
    expect(window.pine.browser.regionCapture).not.toHaveBeenCalled()
  })

  it('starts from the palette command only for its own pane', async () => {
    const { workspaceId } = twoTerminals()
    renderView(workspaceId)
    expect(startRegionCapture('another-pane')).toBe(false)
    act(() => {
      expect(startRegionCapture(BROWSER)).toBe(true)
    })
    expect(layer()).toBeInTheDocument()
  })

  it('asks main to capture the dragged rectangle and offers send and copy', async () => {
    const panes = twoTerminals()
    vi.mocked(window.pine.browser.regionCapture).mockResolvedValue({ ok: true, capture: region })
    vi.mocked(window.pine.browser.regionSend).mockResolvedValue({
      ok: true,
      path: '/tmp/pine-reports-1000/capture-2-localhost.md',
      imagePath: '/tmp/pine-reports-1000/capture-2-localhost.png',
    })
    renderView(panes.workspaceId)
    await userEvent.click(regionButton())
    drag()

    expect(window.pine.browser.regionCapture).toHaveBeenCalledWith(BROWSER, {
      rect: { x: 10, y: 20, width: 120, height: 80 },
      view: { width: 640, height: 480 },
    })
    const panel = await screen.findByRole('region', { name: /send to agent/i })
    expect(panel).toHaveTextContent('Region 120 × 80 px · App')
    expect(screen.queryByRole('application', { name: /region capture/i })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(window.pine.browser.regionSend).toHaveBeenCalledWith({
        captureId: 'region-3',
        sourcePaneId: BROWSER,
        targetPaneId: expect.any(String),
        note: '',
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /send to agent/i })).not.toBeInTheDocument(),
    )
  })

  it('copies the image instead of sending when asked', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.pine.browser.regionCapture).mockResolvedValue({ ok: true, capture: region })
    renderView(workspaceId)
    await userEvent.click(regionButton())
    drag()
    await screen.findByRole('region', { name: /send to agent/i })
    await userEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    expect(window.pine.browser.regionCopy).toHaveBeenCalledWith(BROWSER, 'region-3')
    expect(window.pine.browser.regionSend).not.toHaveBeenCalled()
    expect(await screen.findByText('Copied the image to the clipboard.')).toBeVisible()
  })

  it('says why when main refuses the capture', async () => {
    const { workspaceId } = twoTerminals()
    vi.mocked(window.pine.browser.regionCapture).mockResolvedValue({ ok: false, error: 'empty' })
    renderView(workspaceId)
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

  it('keeps what the user is typing when a slow page finishes loading', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await userEvent.clear(address)
    await userEvent.type(address, 'proxmox.example.com')

    navigated(container, 'about:blank')

    expect(address).toHaveValue('proxmox.example.com')
  })

  it('follows navigation when the user is not typing, and Escape restores the page address', async () => {
    const { workspaceId } = twoTerminals()
    const { container } = renderView(workspaceId)
    const address = screen.getByRole('textbox', { name: /address/i })
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())

    navigated(container, 'http://localhost/docs')
    expect(address).toHaveValue('http://localhost/docs')

    await userEvent.type(address, 'x{Escape}')
    expect(address).toHaveValue('http://localhost/docs')
  })
})

describe('BrowserView storage panel', () => {
  it('opens the storage panel for this pane from the toolbar and closes it again', async () => {
    const { workspaceId } = twoTerminals()
    renderView(workspaceId)
    expect(screen.queryByRole('region', { name: 'Storage' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show storage' }))
    expect(screen.getByRole('region', { name: 'Storage' })).toBeInTheDocument()
    expect(window.pine.browser.storageRead).toHaveBeenCalledWith(BROWSER)
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

  afterEach(() => useSandboxStore.setState({ enabled: {} }))

  it('claims its profile from main and uses the partition main granted', async () => {
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(window.pine.browser.claimProfile).toHaveBeenCalledWith(BROWSER, 'shared')
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'persist:pine-browser',
    )
  })

  it('falls back to its own isolated partition when main refuses the shared profile', async () => {
    vi.mocked(window.pine.browser.claimProfile).mockResolvedValueOnce('isolated')
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      `pine-browser-${BROWSER}`,
    )
  })

  it('asks only for an isolated profile in a sandboxed workspace', async () => {
    useSandboxStore.setState({ enabled: { ws: true } })
    const { container } = renderWith('ws', 'shared')
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    expect(window.pine.browser.claimProfile).toHaveBeenCalledWith(BROWSER, 'isolated')
    expect(window.pine.browser.claimProfile).not.toHaveBeenCalledWith(BROWSER, 'shared')
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
