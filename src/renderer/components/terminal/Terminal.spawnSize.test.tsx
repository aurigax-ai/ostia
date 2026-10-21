import { act, cleanup, render, waitFor } from '@testing-library/react'
import { FitAddon } from '@xterm/addon-fit'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'
import { firstPaneId } from '@/lib/layout/tree'
import { loadGhostty } from '@/lib/terminal/ghosttyEngine'
import {
  noteFittedGrid,
  resetOffscreenStartForTests,
  startOffscreen,
} from '@/lib/terminal/offscreenStart'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { TerminalView } from './Terminal'

vi.mock('@/lib/terminal/softwareGl', () => ({ drawOnGpu: (requested: boolean) => requested }))

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const box = { width: 0, height: 0 }
const observers = new Set<{ notify(): void }>()

class LayoutObserver {
  private readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.targets.add(target)
    observers.add(this)
  }
  unobserve(target: Element): void {
    this.targets.delete(target)
  }
  disconnect(): void {
    this.targets.clear()
    observers.delete(this)
  }
  notify(): void {
    const entries = [...this.targets].map((target) => ({ target }) as ResizeObserverEntry)
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver)
  }
}

function layOut(width: number, height: number): void {
  box.width = width
  box.height = height
  for (const observer of [...observers]) observer.notify()
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

const sizeProps = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const
const realGetContext = HTMLCanvasElement.prototype.getContext
const realResizeObserver = globalThis.ResizeObserver

describe('TerminalView spawn size', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind !== '2d') return null
      const noop = () => {}
      return new Proxy(
        { canvas: this, measureText: (text: string) => ({ width: text.length * 8 }) },
        {
          get: (target, key) => (key in target ? target[key as keyof typeof target] : noop),
          set: () => true,
        },
      )
    } as typeof HTMLCanvasElement.prototype.getContext
    for (const prop of sizeProps) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => (prop.endsWith('Width') ? box.width : box.height),
      })
    }
    globalThis.ResizeObserver = LayoutObserver as unknown as typeof ResizeObserver
  })

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext
    for (const prop of sizeProps) Reflect.deleteProperty(HTMLElement.prototype, prop)
    globalThis.ResizeObserver = realResizeObserver
  })

  beforeEach(async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, renderer: 'ghostty' },
    })
    await loadGhostty()
  })

  afterEach(() => {
    cleanup()
    observers.clear()
    resetOffscreenStartForTests()
    useSettingsStore.setState(settingsInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.clearAllMocks()
  })

  it('starts the shell at the size its split settles at, not the provisional size it mounts with', async () => {
    box.width = 261
    box.height = 600
    render(<TerminalView workspaceId="w1" paneId="p1" />)
    await act(nextFrame)
    expect(window.ostia.pty.attach).not.toHaveBeenCalled()

    await act(async () => {
      layOut(520, 600)
      await nextFrame()
    })
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalledTimes(1))

    await act(async () => {
      layOut(520, 600)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await nextFrame()
    })
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()
  })

  it('starts a terminal an extension opened on screen at its own fitted size, not the last remembered grid', async () => {
    noteFittedGrid(129, 42)
    box.width = 520
    box.height = 600
    startOffscreen('p1')
    render(<TerminalView workspaceId="w1" paneId="p1" />)
    await act(async () => {
      layOut(520, 600)
      await nextFrame()
    })
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalledTimes(1))
    expect(window.ostia.pty.attach).not.toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ cols: 129 }),
    )
  })

  it('leaves a hidden xterm grid alone and fits it once the pane is shown', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, renderer: 'xterm' },
    })
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({
      cols: Math.floor(box.width / 10),
      rows: Math.floor(box.height / 20),
    }))
    onTestFinished(() => fitted.mockRestore())
    useLayoutStore.getState().ensure('w1')
    const paneId = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    box.width = 520
    box.height = 600
    const { container } = render(<TerminalView workspaceId="w1" paneId={paneId} />)
    await act(async () => {
      layOut(520, 600)
      await nextFrame()
    })
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalledTimes(1))
    expect(container.querySelector('.xterm-screen')).toBeNull()

    await act(async () => {
      layOut(900, 600)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await nextFrame()
    })
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()

    act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w1' }))
    expect(container.querySelector('.xterm-screen')).not.toBeNull()
    await act(async () => {
      layOut(900, 600)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await nextFrame()
    })
    expect(window.ostia.pty.resize).toHaveBeenCalledWith(paneId, 90, 30)
  })

  it('starts a terminal an extension opened in a laid-out hidden tab while the window draws no frames', async () => {
    noteFittedGrid(129, 42)
    box.width = 520
    box.height = 600
    startOffscreen('p1')
    render(<TerminalView workspaceId="w1" paneId="p1" />)
    await act(nextFrame)
    expect(window.ostia.pty.attach).not.toHaveBeenCalled()
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    })
  })

  it('reattaches a parked kept shell at the size tmux already has, not the remembered grid', async () => {
    noteFittedGrid(129, 42)
    vi.mocked(window.ostia.pty.attach).mockResolvedValueOnce({
      created: false,
      buffer: '',
      cursor: 0,
      dropped: false,
      kept: true,
      reattached: true,
      cols: 72,
      rows: 48,
    })
    box.width = 0
    box.height = 0
    startOffscreen('p1', { keepSize: true })
    render(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cols: 0, rows: 0 }),
      ),
    )
    await waitFor(() => expect(terminalFor('p1')?.cols).toBe(72))
    expect(terminalFor('p1')?.rows).toBe(48)
  })

  it('starts a parked terminal an extension opened at the last remembered grid', async () => {
    noteFittedGrid(129, 42)
    box.width = 0
    box.height = 0
    startOffscreen('p1')
    render(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cols: 129, rows: 42 }),
      ),
    )
  })
})
