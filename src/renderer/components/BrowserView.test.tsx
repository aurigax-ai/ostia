import type { PickCapture, PickOutcome, PickState } from '@shared/pick'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetIds } from '../layout/tree'
import { useAttentionStore } from '../stores/attentionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePaneRecencyStore } from '../stores/paneRecencyStore'
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

afterEach(() => {
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
  return { workspaceId, a, b }
}

function renderView(workspaceId: string) {
  return render(
    <TooltipProvider>
      <BrowserView workspaceId={workspaceId} paneId={BROWSER} url="http://localhost/" />
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
    expect(screen.getByLabelText(/what's wrong/i)).toHaveFocus()
    expect(screen.getByText('button#save 80×24')).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios.find((r) => (r as HTMLInputElement).checked)).toHaveAttribute('value', a)
  })

  it('sends the note to the chosen pane and confirms in the browser pane', async () => {
    const { b } = await capturedPanel()
    vi.mocked(window.pine.browser.pickSend).mockResolvedValue({
      ok: true,
      path: '/tmp/pine-reports-1000/ui-issue-1.md',
    })
    await userEvent.type(screen.getByLabelText(/what's wrong/i), 'Save overlaps the footer')
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

    navigated(container, 'http://localhost/docs')
    expect(address).toHaveValue('http://localhost/docs')

    await userEvent.type(address, 'x{Escape}')
    expect(address).toHaveValue('http://localhost/docs')
  })
})
