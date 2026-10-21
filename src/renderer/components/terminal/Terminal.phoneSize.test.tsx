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
import { resetOffscreenStartForTests } from '@/lib/terminal/offscreenStart'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
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

describe('TerminalView phone size hold', () => {
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

  async function shown(attached?: Record<string, unknown>) {
    if (attached) {
      vi.mocked(window.ostia.pty.attach).mockResolvedValue({
        created: false,
        buffer: '',
        cursor: 0,
        dropped: false,
        ...attached,
      })
    }
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, renderer: 'xterm' },
    })
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({
      cols: Math.floor(box.width / 10),
      rows: Math.floor(box.height / 20),
    }))
    onTestFinished(() => fitted.mockRestore())
    useLayoutStore.getState().ensure('w1')
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    const paneId = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    box.width = 900
    box.height = 600
    render(<TerminalView workspaceId="w1" paneId={paneId} />)
    await act(async () => {
      layOut(900, 600)
      await nextFrame()
    })
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalledTimes(1))
    const sized = vi.mocked(window.ostia.pty.onSize).mock.calls.find(([id]) => id === paneId)?.[1]
    expect(sized).toBeDefined()
    return { paneId, sized: sized as (cols: number, rows: number, held: boolean) => void }
  }

  it('takes the phone grid main holds the pane at, and says so until main gives the size back', async () => {
    const { paneId, sized } = await shown()
    act(() => sized(40, 20, true))
    expect(terminalFor(paneId)?.cols).toBe(40)
    expect(terminalFor(paneId)?.rows).toBe(20)
    expect(usePhoneSizeStore.getState().byPane[paneId]?.cols).toBe(40)
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()

    act(() => sized(90, 30, false))
    expect(terminalFor(paneId)?.cols).toBe(90)
    expect(usePhoneSizeStore.getState().byPane[paneId]).toBeUndefined()
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()
  })

  it('asks main for the window size from the notice action, which ends the hold', async () => {
    const { paneId, sized } = await shown()
    act(() => sized(40, 20, true))
    act(() => usePhoneSizeStore.getState().byPane[paneId]?.useDesktop())
    expect(window.ostia.pty.resize).toHaveBeenCalledWith(paneId, 90, 30)
  })

  it('keeps the hold when the grid change makes the terminal observe itself, and ends it when the pane box changes', async () => {
    const { paneId, sized } = await shown()
    act(() => sized(40, 20, true))
    await act(async () => {
      layOut(900, 600)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await nextFrame()
    })
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()
    expect(usePhoneSizeStore.getState().byPane[paneId]).toBeDefined()
    await act(async () => {
      layOut(800, 500)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await nextFrame()
    })
    expect(window.ostia.pty.resize).toHaveBeenCalledWith(paneId, 80, 25)
  })

  it('shows the hold again when a window attaches to a pane main still holds, after a reload', async () => {
    const { paneId } = await shown({ cols: 40, rows: 20, held: true })
    await waitFor(() => expect(usePhoneSizeStore.getState().byPane[paneId]?.cols).toBe(40))
    expect(terminalFor(paneId)?.cols).toBe(40)
    expect(terminalFor(paneId)?.rows).toBe(20)
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()
  })

  it("does not follow a resize it was not held for, such as the manager mirror's", async () => {
    const { paneId, sized } = await shown()
    const before = terminalFor(paneId)?.cols
    act(() => sized(100, 30, false))
    expect(terminalFor(paneId)?.cols).toBe(before)
    expect(window.ostia.pty.resize).not.toHaveBeenCalled()
  })

  it('gives the hold up on a desktop mouse press only while the program reports the mouse', async () => {
    const { paneId, sized } = await shown()
    act(() => sized(40, 20, true))
    const host = document.querySelector('textarea') ?? document.body
    const press = (): void => {
      const event = new MouseEvent('mousedown', { bubbles: true })
      act(() => {
        host.dispatchEvent(event)
      })
    }
    const tracking = (mode: string): Promise<void> =>
      new Promise((resolve) => terminalFor(paneId)?.write(mode, resolve))
    await tracking('\x1b[?1000l')
    press()
    expect(window.ostia.pty.releaseHold).not.toHaveBeenCalled()
    await tracking('\x1b[?1000h')
    press()
    expect(window.ostia.pty.releaseHold).toHaveBeenCalledWith(paneId)
  })

  it('drops the notice with the pane', async () => {
    const { paneId, sized } = await shown()
    act(() => sized(40, 20, true))
    cleanup()
    expect(usePhoneSizeStore.getState().byPane[paneId]).toBeUndefined()
  })
})
