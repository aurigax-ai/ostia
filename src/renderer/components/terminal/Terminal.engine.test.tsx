import '@testing-library/jest-dom/vitest'
import type { ClipboardContents } from '@shared/app/appApi'
import { PTY_ACK_CHARS } from '@shared/terminal/ptyFlow'
import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FitAddon } from '@xterm/addon-fit'
import type { ILink, ILinkHandler, ILinkProvider, Terminal as Xterm } from '@xterm/xterm'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { commands } from '@/commands/registry'
import { FilesView } from '@/components/files/FilesView'
import { startCtrlTracking } from '@/lib/app/wheelZoom'
import { focusPaneInDirection } from '@/lib/attention/workspaceActivity'
import { runAppChord } from '@/lib/keyboard/chords'
import { CLIPBOARD_READ_MS } from '@/lib/keyboard/clipboardKeys'
import { allPanes, createPane, findPane, firstPaneId, tabsOf } from '@/lib/layout/tree'
import { loadGhostty } from '@/lib/terminal/ghosttyEngine'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { createFileLinkProvider } from '@/lib/terminalLinks/terminalFileLinks'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useEditorRevealStore } from '@/stores/files/editorRevealStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { releaseSurfaces, surfaceHost } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { renderSettled } from '../../../../test/render'
import { TerminalView } from './Terminal'

const os = vi.hoisted(() => ({ mac: false }))

vi.mock('@/platform', () => ({
  get platform() {
    return os.mac ? 'darwin' : 'linux'
  },
  get isMac() {
    return os.mac
  },
  get isLinux() {
    return !os.mac
  },
}))

const xtermRenderer = vi.hoisted(() => ({
  pause: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}))
const gl = vi.hoisted(() => ({ software: false }))

vi.mock('@/lib/terminal/softwareGl', () => ({
  drawOnGpu: (requested: boolean) => requested && !gl.software,
}))

vi.mock('@/lib/terminal/xtermRenderer', () => ({
  createXtermRenderer: (...args: unknown[]) => {
    xtermRenderer.create(...args)
    return xtermRenderer
  },
}))

vi.mock('@/lib/terminalLinks/terminalFileLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminalLinks/terminalFileLinks')>()
  return { ...actual, createFileLinkProvider: vi.fn(actual.createFileLinkProvider) }
})

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const realGetContext = HTMLCanvasElement.prototype.getContext
const realResizeObserver = globalThis.ResizeObserver

class InitialObservation {
  private connected = true
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    setTimeout(() => {
      if (this.connected) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
    })
  }
  unobserve(): void {}
  disconnect(): void {
    this.connected = false
  }
}

function useGhostty(): void {
  useSettingsStore.setState({
    terminal: { ...useSettingsStore.getState().terminal, renderer: 'ghostty' },
  })
}

async function renderGhostty(ui: ReactElement): Promise<RenderResult> {
  useGhostty()
  const result = render(ui)
  await act(() => loadGhostty())
  return result
}

const linkRange = { start: { x: 1, y: 1 }, end: { x: 30, y: 1 } }

const click = (init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent('click', { detail: 1, ...init })

function showWorkspace(): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'me', kind: 'terminal', workDir: '/home/me', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
}

async function renderLinkTerminal(): Promise<{
  term: Xterm
  links: ILinkHandler
  paneId: string
}> {
  showWorkspace()
  useLayoutStore.getState().ensure('w1')
  const paneId = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
  await renderSettled(<TerminalView workspaceId="w1" paneId={paneId} />)
  const term = terminalFor(paneId) as unknown as Xterm
  return { term, links: term.options.linkHandler as ILinkHandler, paneId }
}

const browserUrls = (): (string | undefined)[] =>
  allPanes(useLayoutStore.getState().byWorkspace.w1.root)
    .filter((pane) => pane.kind === 'browser')
    .map((pane) => pane.url)

const shownUrl = (): string | undefined => {
  const layout = useLayoutStore.getState().byWorkspace.w1
  return allPanes(layout.root).find((pane) => pane.id === layout.activePaneId)?.url
}

describe('TerminalView engines', () => {
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
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
    globalThis.ResizeObserver = InitialObservation as unknown as typeof ResizeObserver
  })

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext
    globalThis.ResizeObserver = realResizeObserver
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    vi.clearAllMocks()
  })

  for (const name of ['zsh', 'bash']) {
    it(`a new terminal tab is named after the shell it runs: ${name}`, async () => {
      useLayoutStore.getState().ensure('w1')
      const paneId = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
      vi.mocked(window.ostia.pty.attach).mockResolvedValueOnce({
        created: true,
        buffer: '',
        cursor: 0,
        dropped: false,
        shell: name,
      })
      await renderSettled(<TerminalView workspaceId="w1" paneId={paneId} />)
      await waitFor(() =>
        expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, paneId)?.title).toBe(name),
      )
    })
  }

  it('a title a program sets with OSC 0 replaces the shell name of the tab', async () => {
    useLayoutStore.getState().ensure('w1')
    const paneId = firstPaneId(useLayoutStore.getState().byWorkspace.w1.root)
    vi.mocked(window.ostia.pty.attach).mockResolvedValueOnce({
      created: true,
      buffer: '',
      cursor: 0,
      dropped: false,
      shell: 'bash',
    })
    await renderSettled(<TerminalView workspaceId="w1" paneId={paneId} />)
    const titleOf = (): string | undefined =>
      findPane(useLayoutStore.getState().byWorkspace.w1.root, paneId)?.title
    await waitFor(() => expect(titleOf()).toBe('bash'))
    await waitFor(() => expect(window.ostia.pty.onData).toHaveBeenCalled())
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    act(() => deliver('\x1b]0;build logs\x07'))
    await waitFor(() => expect(titleOf()).toBe('build logs'))
  })

  it('an xterm pane hands its renderer to the hidden-pane pause and drops it on unmount', async () => {
    const { unmount } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    expect(xtermRenderer.pause).toHaveBeenLastCalledWith(true)
    unmount()
    expect(xtermRenderer.dispose).toHaveBeenCalledTimes(1)
  })

  it('an xterm pane stays on the DOM renderer and still parks when WebGL runs in software', async () => {
    gl.software = true
    try {
      const { unmount } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      expect(xtermRenderer.create).toHaveBeenLastCalledWith(expect.anything(), false)
      expect(xtermRenderer.pause).toHaveBeenLastCalledWith(true)
      unmount()
      expect(xtermRenderer.dispose).toHaveBeenCalledTimes(1)
    } finally {
      gl.software = false
    }
  })

  it('draws a new terminal with Ghostty and starts its shell through the shared path', async () => {
    const { container } = await renderGhostty(
      <TerminalView workspaceId="w1" paneId="p1" cwd="/home/me" />,
    )
    await waitFor(() => expect(container.querySelector('.ghostty-host canvas')).not.toBeNull())
    expect(container.querySelector('.ghostty-screen')).not.toBeNull()
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cwd: '/home/me', role: 'owner' }),
      ),
    )
  })

  it('a woken agent starts in the folder its session belongs to, not the pane’s folder', async () => {
    const pane = { ...createPane('terminal'), id: 'p1', cwd: '/w', spawnDir: '/w/tree' }
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" cwd="/w/tree" />)
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cwd: '/w/tree' }),
      ),
    )
    await waitFor(() =>
      expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')).not.toHaveProperty(
        'spawnDir',
      ),
    )
    expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')).not.toHaveProperty(
      'resumeFolderMissing',
    )
  })

  it('waking an agent whose folder was removed marks the folder missing when main says so', async () => {
    const pane = { ...createPane('terminal'), id: 'p1', cwd: '/w', spawnDir: '/w/gone' }
    useLayoutStore.setState({
      byWorkspace: { w1: { root: pane, activePaneId: 'p1', zoomedPaneId: null } },
    })
    vi.mocked(window.ostia.pty.attach).mockResolvedValueOnce({
      created: true,
      buffer: '',
      cursor: 0,
      dropped: false,
      cwdMissing: true,
    })
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" cwd="/w/gone" />)
    await waitFor(() =>
      expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')).toMatchObject({
        resumeFolderMissing: '/w/gone',
      }),
    )
    expect(findPane(useLayoutStore.getState().byWorkspace.w1.root, 'p1')).not.toHaveProperty(
      'spawnDir',
    )
  })

  it('keeps xterm.js for a terminal opened before the switch', async () => {
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    act(() => useGhostty())
    expect(container.querySelector('.xterm-host')).not.toBeNull()
    expect(container.querySelector('.ghostty-host')).toBeNull()
  })

  it('lets Option-drag fall back to native selection under mouse tracking in xterm.js', async () => {
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    expect(terminalFor('p1')?.options.macOptionClickForcesSelection).toBe(true)
  })

  it('rescales glyphs that overlap their cell in xterm.js', async () => {
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    expect(terminalFor('p1')?.options.rescaleOverlappingGlyphs).toBe(true)
  })

  it('keeps the kitty keyboard protocol off in xterm.js', async () => {
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const xterm = terminalFor('p1') as unknown as Xterm
    expect(xterm.options.vtExtensions?.kittyKeyboard).toBe(false)
  })

  it('sends ESC CR for Shift+Enter in xterm.js', async () => {
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true })
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', '\x1b\r', undefined),
    )
    expect(window.ostia.pty.write).not.toHaveBeenCalledWith('p1', '\r', undefined)
  })

  it('tags a key the human pressed in the terminal as typed, and the same data from a command as untagged', async () => {
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    Object.defineProperty(window, 'event', {
      value: { isTrusted: true, type: 'keydown', target: textarea },
      configurable: true,
    })
    onTestFinished(() => {
      Reflect.deleteProperty(window, 'event')
    })
    fireEvent.keyDown(textarea, { key: 'a', code: 'KeyA', keyCode: 65 })
    expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'a', 'key')
    Reflect.deleteProperty(window, 'event')
    terminalFor('p1')?.input('b', true)
    expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'b', undefined)
  })

  it('repaints a held prompt once and acks it once after a resize in xterm.js', async () => {
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    const prompt = '\x1b]133;A\x07$ '
    act(() => deliver(prompt))
    await waitFor(() => expect(useBlocksStore.getState().drafts.p1).toBeDefined())
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const fitted = vi
      .spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 100, rows: 30 })
    onTestFinished(() => fitted.mockRestore())
    act(() =>
      useSettingsStore.setState((s) => ({
        appearance: {
          ...s.appearance,
          terminal: { ...s.appearance.terminal, size: s.appearance.terminal.size + 1 },
        },
      })),
    )
    await waitFor(() => expect(window.ostia.pty.resize).toHaveBeenCalledWith('p1', 100, 30))
    const xterm = terminalFor('p1') as unknown as Xterm
    const writes = vi.spyOn(xterm, 'write')
    const redraw = `\r\x1b[K$ ${'r'.repeat(PTY_ACK_CHARS)}`
    act(() => deliver(redraw))
    await waitFor(() => expect(xterm.cols).toBe(100))
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(writes.mock.calls.filter(([data]) => data === redraw)).toHaveLength(1)
    expect(vi.mocked(window.ostia.pty.ack).mock.calls).toEqual([
      ['p1', prompt.length + redraw.length],
    ])
  })

  it('draws and acks output once when a resize lands between write slices in xterm.js', async () => {
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    const chunks = ['first', 'second', 'third'].map(
      (word) => `${word}-out\r\n${' '.repeat(PTY_ACK_CHARS)}\r\n`,
    )
    const fitted = vi
      .spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 100, rows: 30 })
    onTestFinished(() => fitted.mockRestore())
    let now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 20
      return now
    })
    act(() => {
      for (const chunk of chunks) deliver(chunk)
    })
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        clock.mockRestore()
        act(() =>
          useSettingsStore.setState((s) => ({
            appearance: {
              ...s.appearance,
              terminal: { ...s.appearance.terminal, size: s.appearance.terminal.size + 1 },
            },
          })),
        )
        resolve()
      }),
    )
    const xterm = terminalFor('p1') as unknown as Xterm
    await waitFor(() => expect(xterm.cols).toBe(100))
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    const lines = Array.from({ length: xterm.buffer.active.length }, (_, y) =>
      xterm.buffer.active.getLine(y)?.translateToString(true),
    )
    expect(lines.filter((line) => line?.endsWith('-out'))).toEqual([
      'first-out',
      'second-out',
      'third-out',
    ])
    expect(vi.mocked(window.ostia.pty.ack).mock.calls).toEqual(
      chunks.map((chunk) => ['p1', chunk.length]),
    )
  })

  describe('a pane that is not the active one', () => {
    async function renderNeighbour(): Promise<(data: string) => void> {
      const pane = { ...createPane('terminal'), id: 'p1' }
      useLayoutStore.setState({
        byWorkspace: { w1: { root: pane, activePaneId: 'other', zoomedPaneId: null } },
      })
      await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      return vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    }

    function screenText(): string {
      const xterm = terminalFor('p1') as unknown as Xterm
      return Array.from(
        { length: xterm.buffer.active.length },
        (_, y) => xterm.buffer.active.getLine(y)?.translateToString(true) ?? '',
      ).join('')
    }

    it('shows the process-exited banner after the output still queued for it', async () => {
      const deliver = await renderNeighbour()
      const exit = vi.mocked(window.ostia.pty.onExit).mock.calls[0][1]
      act(() => {
        deliver('last-words\r\n')
        exit(0, false)
      })
      await act(() => new Promise((resolve) => setTimeout(resolve, 200)))
      const text = screenText()
      expect(text).toContain('last-words')
      expect(text.indexOf('last-words')).toBeLessThan(text.indexOf('[process exited]'))
    })

    it('acknowledges everything it was sent once the coalesced write is parsed', async () => {
      const deliver = await renderNeighbour()
      const chunks = ['one', 'two', 'three'].map(
        (word) => `${word}-out\r\n${' '.repeat(PTY_ACK_CHARS)}\r\n`,
      )
      act(() => {
        for (const chunk of chunks) deliver(chunk)
      })
      expect(vi.mocked(window.ostia.pty.ack)).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(vi.mocked(window.ostia.pty.ack).mock.calls).toEqual([
          ['p1', chunks.reduce((sum, chunk) => sum + chunk.length, 0)],
        ]),
      )
      expect(screenText()).toMatch(/one-out.*two-out.*three-out/)
    })
  })

  it('keeps Option-drag away from the program in a Ghostty terminal on macOS only', async () => {
    const { container } = await renderGhostty(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(container.querySelector('.ghostty-host canvas')).not.toBeNull())
    const canvas = container.querySelector('.ghostty-host canvas') as HTMLCanvasElement
    const reported: string[] = []
    const report = (e: Event) => reported.push(e.type)
    const host = canvas.parentElement as HTMLElement
    for (const type of ['mousedown', 'mousemove', 'mouseup']) host.addEventListener(type, report)
    const drag = (altKey: boolean) => {
      reported.length = 0
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, altKey }))
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey, buttons: 1 }))
      canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, altKey }))
      return [...reported]
    }
    os.mac = true
    onTestFinished(() => {
      os.mac = false
    })
    expect(drag(true)).toEqual([])
    expect(drag(false)).toEqual(['mousedown', 'mousemove', 'mouseup'])
    os.mac = false
    expect(drag(true)).toEqual(['mousedown', 'mousemove', 'mouseup'])
  })

  it('smart copy/paste keys paste with Ctrl+V', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
    })
    const readText = vi.fn().mockResolvedValue('echo pasted_$((6*7))')
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
    onTestFinished(() => {
      if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'v', code: 'KeyV', ctrlKey: true })
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'echo pasted_$((6*7))', 'paste'),
    )
  })

  it('Ctrl+scroll over a terminal zooms its font in and out', async () => {
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const target = container.querySelector('.xterm') as HTMLElement
    const fontSize = () => terminalFor('p1')?.options.fontSize ?? 0
    const scroll = (deltaY: number) =>
      act(() => {
        for (let i = 0; i < 4; i++) {
          target.dispatchEvent(
            new WheelEvent('wheel', { deltaY, ctrlKey: true, cancelable: true, bubbles: true }),
          )
        }
      })

    const stopTracking = startCtrlTracking()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    const before = fontSize()
    scroll(-100)
    expect(fontSize()).toBeGreaterThan(before)

    const zoomed = fontSize()
    scroll(100)
    expect(fontSize()).toBeLessThan(zoomed)
    stopTracking()
  })

  it('moves the pane cwd to the folder an xterm shell reports with OSC 7', async () => {
    useLayoutStore.getState().ensure('w1')
    const { activePaneId } = useLayoutStore.getState().byWorkspace.w1
    await renderSettled(<TerminalView workspaceId="w1" paneId={activePaneId} />)
    await waitFor(() => expect(window.ostia.pty.onData).toHaveBeenCalled())
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    act(() => deliver('\x1b]7;file:///tmp\x07'))
    await waitFor(() => {
      const { root } = useLayoutStore.getState().byWorkspace.w1
      expect(findPane(root, activePaneId)).toMatchObject({ cwd: '/tmp' })
    })
  })

  it('asks before pasting several lines into a Ghostty terminal', async () => {
    const { container } = await renderGhostty(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(container.querySelector('.ghostty-host textarea')).not.toBeNull())
    const textarea = container.querySelector('.ghostty-host textarea') as HTMLTextAreaElement
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'rm -rf build\nmake' },
    })
    act(() => {
      textarea.dispatchEvent(paste)
    })
    expect(await screen.findByRole('button', { name: 'Paste' })).toBeVisible()
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
  })

  for (const [system, reload, sent] of [
    ['Linux', { key: 'F5', code: 'F5', keyCode: 116, ctrlKey: true }, ['\x1b[15;5~', '\x15']],
    ['macOS', { key: 'r', code: 'KeyR', keyCode: 82, metaKey: true }, ['\x15']],
  ] as const) {
    it(`a browser key pressed in a terminal goes to the shell as an unbound key and pastes nothing: ${system}`, async () => {
      os.mac = system === 'macOS'
      onTestFinished(() => {
        os.mac = false
      })
      const readText = vi.fn().mockResolvedValue('echo ostia_should_not_paste')
      const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
      onTestFinished(() => {
        if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
        else Reflect.deleteProperty(navigator, 'clipboard')
      })
      const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, reload)
      fireEvent.keyDown(textarea, { key: 'u', code: 'KeyU', keyCode: 85, ctrlKey: true })
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
      expect(readText).not.toHaveBeenCalled()
      expect(vi.mocked(window.ostia.pty.write).mock.calls).toEqual(
        sent.map((data) => ['p1', data, undefined]),
      )
    })
  }

  it('smart Ctrl+V hands an image-only clipboard to the program as Ctrl+V', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
    })
    vi.mocked(window.ostia.clipboard.contents).mockResolvedValueOnce({ files: [], image: true })
    const user = userEvent.setup()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    act(() => textarea.focus())
    await user.keyboard('{Control>}v{/Control}')
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', '\x16', undefined),
    )
  })

  for (const [name, text, contents, written, source] of [
    [
      'the quoted path of a copied file even when text is on the clipboard too',
      'shot.png',
      { files: ['/tmp/my shot.png'], image: true },
      "'/tmp/my shot.png' ",
      undefined,
    ],
    [
      'the text of a spreadsheet copy that carries an image preview',
      'Name\tQty',
      { files: [], image: true },
      'Name\tQty',
      'paste',
    ],
    [
      'Ctrl+V for an image whose text is a file name',
      'shot.png',
      { files: [], image: true },
      '\x16',
      undefined,
    ],
  ] as const) {
    it(`smart Ctrl+V pastes ${name}`, async () => {
      useSettingsStore.setState({
        terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
      })
      const readText = vi.fn().mockResolvedValue(text)
      const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
      onTestFinished(() => {
        if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
        else Reflect.deleteProperty(navigator, 'clipboard')
      })
      vi.mocked(window.ostia.clipboard.contents).mockResolvedValueOnce({
        files: [...contents.files],
        image: contents.image,
      })
      const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      fireEvent.keyDown(textarea, { key: 'v', code: 'KeyV', ctrlKey: true })
      await waitFor(() =>
        expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', written, source),
      )
    })
  }

  it('smart Ctrl+V pastes the quoted path of a copied file even when its image is on the clipboard too', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
    })
    vi.mocked(window.ostia.clipboard.contents).mockResolvedValueOnce({
      files: ['/tmp/my shot.png'],
      image: true,
    })
    const user = userEvent.setup()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    act(() => textarea.focus())
    await user.keyboard('{Control>}v{/Control}')
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', "'/tmp/my shot.png' ", undefined),
    )
    expect(window.ostia.pty.write).not.toHaveBeenCalledWith('p1', '\x16', undefined)
  })

  const written = (...wanted: string[]): string[] =>
    vi
      .mocked(window.ostia.pty.write)
      .mock.calls.map(([, data]) => data)
      .filter((data) => wanted.includes(data))

  const pasteEvent = (target: HTMLElement, text: string, types: string[]): void => {
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? text : ''), types },
    })
    act(() => {
      target.dispatchEvent(paste)
    })
  }

  const pressEnter = (target: HTMLElement): void => {
    fireEvent.keyDown(target, { key: 'Enter', code: 'Enter', keyCode: 13 })
  }

  const clipboardText = (text: string): void => {
    const readText = vi.fn().mockResolvedValue(text)
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
    onTestFinished(() => {
      if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })
  }

  const waitStopped = (check: () => void): Promise<void> =>
    act(async () => {
      await vi.waitFor(check)
    })

  const stopClipboardClock = (): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
  }

  const heldContents = (): ((contents: ClipboardContents) => void) => {
    let release: (contents: ClipboardContents) => void = () => {}
    vi.mocked(window.ostia.clipboard.contents).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    return (contents) => act(() => release(contents))
  }

  it('a plain-text Cmd+V on macOS goes in at once, before the Enter pressed right after it', async () => {
    os.mac = true
    onTestFinished(() => {
      os.mac = false
    })
    clipboardText('echo hi')
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    pasteEvent(textarea, 'echo hi', ['text/plain'])
    pressEnter(textarea)
    expect(written('echo hi', '\r')).toEqual(['echo hi', '\r'])
    expect(window.ostia.clipboard.contents).not.toHaveBeenCalled()
  })

  for (const [title, contents, pasted] of [
    [
      'a Cmd+V on macOS that may carry a file sends the text before the Enter pressed while the clipboard is read',
      { files: [], image: false },
      'echo hi',
    ],
    [
      'a Cmd+V on macOS that may carry a file sends the quoted path of a copied file before the Enter pressed while the clipboard is read',
      { files: ['/tmp/a b.png'], image: true },
      "'/tmp/a b.png' ",
    ],
  ] as const) {
    it(title, async () => {
      os.mac = true
      onTestFinished(() => {
        os.mac = false
      })
      clipboardText('echo hi')
      const release = heldContents()
      const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      stopClipboardClock()
      pasteEvent(textarea, 'echo hi', ['Files', 'text/plain'])
      pressEnter(textarea)
      await waitStopped(() => expect(window.ostia.clipboard.contents).toHaveBeenCalled())
      expect(written(pasted, '\r')).toEqual([])
      release({ files: [...contents.files], image: contents.image })
      await waitStopped(() => expect(written(pasted, '\r')).toEqual([pasted, '\r']))
    })
  }

  it('a Cmd+V on macOS pastes the text of the paste when the clipboard read hangs', async () => {
    os.mac = true
    onTestFinished(() => {
      os.mac = false
    })
    clipboardText('echo hi')
    vi.mocked(window.ostia.clipboard.contents).mockReturnValueOnce(new Promise(() => {}))
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    stopClipboardClock()
    pasteEvent(textarea, 'echo hi', ['Files', 'text/plain'])
    pressEnter(textarea)
    await waitStopped(() => expect(window.ostia.clipboard.contents).toHaveBeenCalled())
    expect(written('echo hi', '\r')).toEqual([])
    act(() => {
      vi.advanceTimersByTime(CLIPBOARD_READ_MS)
    })
    await waitStopped(() => expect(written('echo hi', '\r')).toEqual(['echo hi', '\r']))
  })

  it('smart Ctrl+V sends the clipboard before the Enter pressed while the clipboard is read', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
    })
    clipboardText('echo hi')
    const release = heldContents()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    stopClipboardClock()
    fireEvent.keyDown(textarea, { key: 'v', code: 'KeyV', ctrlKey: true })
    pressEnter(textarea)
    await waitStopped(() => expect(window.ostia.clipboard.contents).toHaveBeenCalled())
    expect(written('echo hi', '\r')).toEqual([])
    release({ files: [], image: false })
    await waitStopped(() => expect(written('echo hi', '\r')).toEqual(['echo hi', '\r']))
  })

  for (const [system, chord] of [
    ['Linux', { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true }],
    ['macOS', { key: 'f', code: 'KeyF', metaKey: true }],
  ] as const) {
    it(`the find chord opens the find bar and Escape closes it: ${system}`, async () => {
      os.mac = system === 'macOS'
      onTestFinished(() => {
        os.mac = false
      })
      vi.mocked(window.ostia.pty.attach).mockResolvedValueOnce({
        created: true,
        buffer: '$ echo ostia_find_target\r\nostia_find_target\r\n$ ',
        cursor: 0,
        dropped: false,
      })
      const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      act(() => textarea.focus())
      fireEvent.keyDown(textarea, chord)
      const input = await screen.findByRole('textbox', { name: 'Find in terminal' })
      expect(input).toHaveFocus()
      fireEvent.change(input, { target: { value: 'ostia_find_target' } })
      await waitFor(() =>
        expect(container.querySelector('.term-find-count')).toHaveTextContent(/\d+\/\d+|\d+/),
      )
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByRole('textbox', { name: 'Find in terminal' })).toBeNull()
    })
  }

  for (const engine of ['xterm', 'Ghostty']) {
    it(`${engine}: Ctrl+click reveals a folder in Files, opens an outside folder in the file manager and opens an outside file; Ctrl+Shift and Ctrl+Shift+Alt hand it to the system, never a program`, async () => {
      const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
      onTestFinished(() => fitted.mockRestore())
      useFileTreeStore.setState({ revealed: null })
      useUIStore.setState({ filesOpen: false })
      useEditorRevealStore.setState({ pending: {} })
      showWorkspace()
      useLayoutStore.setState({
        byWorkspace: {
          w1: {
            root: { ...createPane('terminal'), id: 'p1' },
            activePaneId: 'p1',
            zoomedPaneId: null,
          },
        },
      })
      vi.mocked(window.ostia.pty.attach).mockResolvedValue({
        created: true,
        buffer: 'notes/sub\r\n/out/shots/\r\n/out/shots/report.txt:7\r\n',
        cursor: 0,
        dropped: false,
      })
      vi.mocked(window.ostia.fs.stat).mockImplementation(async (path) =>
        path === '/home/me/notes/sub' ? 'dir' : null,
      )
      vi.mocked(window.ostia.terminalLinks.probe).mockImplementation(async (_pane, path) =>
        path === '/out/shots' ? 'dir' : path === '/out/shots/report.txt' ? 'file' : null,
      )
      vi.mocked(window.ostia.terminalLinks.admit).mockResolvedValue({
        ok: true,
        path: '/out/shots/report.txt',
      })
      vi.mocked(window.ostia.terminalLinks.openDefault).mockResolvedValue({ ok: true })
      vi.mocked(window.ostia.terminalLinks.showInFolder).mockResolvedValue({ ok: true })
      const openFile = vi.spyOn(useLayoutStore.getState(), 'openFile')
      const rect = vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 800, 600))
      try {
        const ui = <TerminalView workspaceId="w1" paneId="p1" cwd="/home/me" />
        if (engine === 'Ghostty') await renderGhostty(ui)
        else await renderSettled(ui)
        await waitFor(() => expect(createFileLinkProvider).toHaveBeenCalled())
        const provider = vi.mocked(createFileLinkProvider).mock.results[0].value as ILinkProvider
        const linkOn = async (row: number): Promise<ILink> => {
          let found: ILink | undefined
          await waitFor(async () => {
            const links = await new Promise<ILink[] | undefined>((resolve) =>
              provider.provideLinks(row, resolve),
            )
            found = links?.[0]
            expect(found).toBeDefined()
          })
          return found as ILink
        }
        const hint = (): Element | null => document.querySelector('[data-slot="tooltip-content"]')
        const hover = (link: ILink): void => {
          act(() => link.hover?.(new MouseEvent('mousemove'), link.text))
        }
        const ctrlClick = (link: ILink, keys: Partial<MouseEvent> = {}): void => {
          act(() =>
            link.activate({ ctrlKey: true, isTrusted: true, ...keys } as MouseEvent, link.text),
          )
        }

        const inside = await linkOn(1)
        hover(inside)
        await waitFor(() => expect(hint()).toHaveTextContent('Ctrl+Click Show the folder in Files'))
        expect(hint()).not.toHaveTextContent('Show in Files')
        expect(hint()).toHaveTextContent('Ctrl+Shift+Click Open the folder in the file manager')
        expect(hint()).toHaveTextContent('Ctrl+Shift+Alt+Click Show in the file manager')
        ctrlClick(inside)
        expect(useFileTreeStore.getState().revealed).toEqual({
          root: '/home/me',
          path: '/home/me/notes/sub',
        })
        expect(useUIStore.getState().filesOpen).toBe(true)
        expect(window.ostia.terminalLinks.openDefault).not.toHaveBeenCalled()

        const folder = await linkOn(2)
        hover(folder)
        await waitFor(() =>
          expect(hint()).toHaveTextContent('Ctrl+Click Open the folder in the file manager'),
        )
        expect(hint()).not.toHaveTextContent('Ctrl+Shift+Click')
        act(() => folder.activate({ ctrlKey: false, isTrusted: true } as MouseEvent, folder.text))
        expect(window.ostia.terminalLinks.openDefault).not.toHaveBeenCalled()
        ctrlClick(folder)
        expect(window.ostia.terminalLinks.openDefault).toHaveBeenCalledWith('p1', '/out/shots')

        const file = await linkOn(3)
        hover(file)
        await waitFor(() => expect(hint()).toHaveTextContent('Ctrl+Click Open the file'))
        expect(hint()).toHaveTextContent('Ctrl+Shift+Click Open with its default app')
        expect(hint()).toHaveTextContent('Ctrl+Shift+Alt+Click Show in the file manager')
        expect(hint()).not.toHaveTextContent('Show in Files')
        ctrlClick(file)
        await waitFor(() =>
          expect(openFile).toHaveBeenCalledWith(expect.any(String), '/out/shots/report.txt'),
        )
        expect(useEditorRevealStore.getState().pending['/out/shots/report.txt']).toEqual({
          line: 7,
          column: 1,
        })
        expect(window.ostia.terminalLinks.admit).toHaveBeenCalledWith('p1', '/out/shots/report.txt')
        expect(window.ostia.terminalLinks.openDefault).toHaveBeenCalledTimes(1)

        ctrlClick(file, { shiftKey: true })
        expect(window.ostia.terminalLinks.openDefault).toHaveBeenLastCalledWith(
          'p1',
          '/out/shots/report.txt',
        )
        ctrlClick(file, { shiftKey: true, altKey: true })
        expect(window.ostia.terminalLinks.showInFolder).toHaveBeenCalledWith(
          'p1',
          '/out/shots/report.txt',
        )
        expect(window.ostia.terminalLinks.admit).toHaveBeenCalledTimes(1)

        vi.mocked(window.ostia.terminalLinks.openDefault).mockResolvedValueOnce({
          ok: false,
          error: 'program',
        })
        ctrlClick(file, { shiftKey: true })
        await waitFor(() =>
          expect(window.ostia.notifications.post).toHaveBeenCalledWith(
            expect.objectContaining({
              kind: 'error',
              title: expect.stringContaining('launch programs or scripts from a terminal link'),
            }),
          ),
        )
      } finally {
        rect.mockRestore()
        openFile.mockRestore()
      }
    })
  }

  it('a single-line paste goes straight in without its newline, and confirmation can be turned off', async () => {
    const user = userEvent.setup()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    const input = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    input.focus()

    await navigator.clipboard.writeText('echo ostiaplain\n')
    await user.keyboard('{Control>}{Shift>}V{/Shift}{/Control}')
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'echo ostiaplain', 'paste'),
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => useSettingsStore.getState().setTerminal({ warnOnRiskyPaste: false }))
    await navigator.clipboard.writeText('\necho ostiaquiet77\n')
    await user.keyboard('{Control>}{Shift>}V{/Shift}{/Control}')
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith(
        'p1',
        expect.stringContaining('echo ostiaquiet77'),
        'paste',
      ),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lowering scrollback in Settings trims history in an open terminal', async () => {
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
    onTestFinished(() => fitted.mockRestore())
    const lines = Array.from({ length: 2000 }, (_, i) => `${i + 1}`)
    vi.mocked(window.ostia.pty.attach).mockResolvedValue({
      created: true,
      buffer: `${lines.join('\r\n')}\r\nscrolldone`,
      cursor: 0,
      dropped: false,
    })
    await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const topLine = (): number =>
      Number(terminalFor('p1')?.buffer.active.getLine(0)?.translateToString(true))
    await waitFor(() => expect(topLine()).toBe(1))

    act(() => useSettingsStore.getState().setTerminal({ scrollbackLines: 1000 }))
    expect(topLine()).toBeGreaterThan(900)
  })

  it('a plain click opens the link in the browser pane and reuses it; Ctrl adds a tab; Ctrl+Shift goes outside', async () => {
    const systemOpen = vi.spyOn(window, 'open').mockReturnValue(null)
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
    const box = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 }))
    onTestFinished(() => {
      systemOpen.mockRestore()
      fitted.mockRestore()
      box.mockRestore()
    })
    const { links, paneId } = await renderLinkTerminal()
    const backToTerminal = () => act(() => useLayoutStore.getState().focusPane('w1', paneId))
    const first = 'http://127.0.0.1:8000/first'
    const second = 'http://127.0.0.1:8000/second'

    act(() => links.hover?.(new MouseEvent('mousemove'), first, linkRange))
    const hint = await waitFor(() => {
      const shown = document.querySelector('[data-slot="tooltip-content"]')
      expect(shown).not.toBeNull()
      return shown as HTMLElement
    })
    expect(hint).toHaveTextContent('Click Open in the browser pane')
    expect(hint).toHaveTextContent('Ctrl+Click Open in a new browser tab')
    expect(hint).toHaveTextContent('Ctrl+Shift+Click Open in the system browser')

    act(() => links.activate(click(), first, linkRange))
    expect(browserUrls()).toEqual([first])
    expect(shownUrl()).toBe(first)

    backToTerminal()
    act(() => links.activate(click(), second, linkRange))
    expect(browserUrls()).toEqual([second])
    expect(shownUrl()).toBe(second)

    backToTerminal()
    act(() => links.activate(click({ ctrlKey: true }), first, linkRange))
    expect(browserUrls()).toHaveLength(2)
    expect(shownUrl()).toBe(first)

    backToTerminal()
    act(() => links.activate(click({ ctrlKey: true, shiftKey: true }), second, linkRange))
    expect(systemOpen).toHaveBeenCalledTimes(1)
    expect(systemOpen).toHaveBeenCalledWith(second, '_blank')
    expect(browserUrls()).toHaveLength(2)
    expect(useLayoutStore.getState().byWorkspace.w1.activePaneId).toBe(paneId)
  })

  it('a plain click on a link never opens while a drag selected text', async () => {
    const { term, links } = await renderLinkTerminal()
    await act(
      () => new Promise<void>((done) => term.write('see http://127.0.0.1:8000/drag\r\n', done)),
    )
    act(() => term.selectAll())
    expect(term.hasSelection()).toBe(true)
    act(() => links.activate(click(), 'http://127.0.0.1:8000/drag', linkRange))
    expect(browserUrls()).toEqual([])
  })

  describe('a link’s hover hint goes away', () => {
    async function renderHinted() {
      const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
      const box = vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 }))
      const settingsActive = useUIStore.getState().settingsActive
      onTestFinished(() => {
        fitted.mockRestore()
        box.mockRestore()
        useUIStore.setState({ settingsActive })
        vi.useRealTimers()
      })
      const { term, links } = await renderLinkTerminal()
      vi.useFakeTimers()
      const hint = (): Element | null => document.querySelector('[data-slot="tooltip-content"]')
      const hover = (): void => {
        act(() =>
          links.hover?.(new MouseEvent('mousemove'), 'http://127.0.0.1:8000/first', linkRange),
        )
      }
      const hoverUntilHinted = (): void => {
        hover()
        act(() => {
          vi.advanceTimersByTime(1_000)
        })
        expect(hint()).not.toBeNull()
      }
      return { term, hint, hover, hoverUntilHinted }
    }

    it('when the settings page covers its pane', async () => {
      const { hint, hoverUntilHinted } = await renderHinted()
      hoverUntilHinted()
      act(() => useUIStore.setState({ settingsActive: true }))
      expect(hint()).toBeNull()
      act(() => useUIStore.setState({ settingsActive: false }))
      expect(hint()).toBeNull()
    })

    it('when another workspace is shown', async () => {
      const { hint, hoverUntilHinted } = await renderHinted()
      hoverUntilHinted()
      act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w2' }))
      expect(hint()).toBeNull()
      act(() => useWorkspacesStore.setState({ activeWorkspaceId: 'w1' }))
      expect(hint()).toBeNull()
    })

    it('when the window loses focus', async () => {
      const { hint, hoverUntilHinted } = await renderHinted()
      hoverUntilHinted()
      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      expect(hint()).toBeNull()
    })

    it('when the terminal resizes', async () => {
      const { term, hint, hoverUntilHinted } = await renderHinted()
      hoverUntilHinted()
      act(() => term.resize(term.cols + 1, term.rows))
      expect(hint()).toBeNull()
    })

    it('when a mouse button goes down, also before the hint has shown', async () => {
      const { term, hint, hover, hoverUntilHinted } = await renderHinted()
      const press = (): void => {
        act(() => {
          term.element?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        })
      }
      hoverUntilHinted()
      press()
      expect(hint()).toBeNull()
      hover()
      press()
      act(() => {
        vi.advanceTimersByTime(1_000)
      })
      expect(hint()).toBeNull()
    })
  })

  it('a Files row starts a native file drag, and that file dropped on the terminal types its quoted path', async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'me', kind: 'terminal', workDir: '/home/me', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    useLayoutStore.getState().ensure('w1')
    vi.mocked(window.ostia.fs.list).mockResolvedValue([{ name: 'notes file.md', dir: false }])
    const { container } = await renderSettled(
      <>
        <FilesView />
        <TerminalView workspaceId="w1" paneId="p1" />
      </>,
    )
    const dragged = fireEvent.dragStart(
      await screen.findByRole('button', { name: 'notes file.md' }),
      { dataTransfer: { setData: vi.fn() } },
    )
    expect(dragged).toBe(false)
    expect(window.ostia.fileOps.startDrag).toHaveBeenCalledWith('w1', '/home/me/notes file.md')
    const file = new File([''], 'notes file.md')
    vi.mocked(window.ostia.files.pathForFile).mockReturnValue('/home/me/notes file.md')
    fireEvent.drop(container.querySelector('.terminal-surface') as HTMLElement, {
      dataTransfer: { types: ['Files'], files: [file], getData: () => '' },
    })

    expect(window.ostia.pty.write).toHaveBeenCalledWith(
      'p1',
      "'/home/me/notes file.md' ",
      undefined,
    )
  })

  for (const [system, binding, rebound, dropped, kept] of [
    [
      'Linux',
      ['Ctrl+Shift+Y', 'F1'],
      { key: 'Y', code: 'KeyY', keyCode: 89, ctrlKey: true, shiftKey: true },
      { key: 'P', code: 'KeyP', keyCode: 80, ctrlKey: true, shiftKey: true },
      [],
    ],
    [
      'macOS',
      ['Shift+Cmd+P', 'Shift+Cmd+Y', 'F1'],
      { key: 'Y', code: 'KeyY', keyCode: 89, metaKey: true, shiftKey: true },
      { key: 'k', code: 'KeyK', keyCode: 75, metaKey: true },
      [{ key: 'P', code: 'KeyP', keyCode: 80, metaKey: true, shiftKey: true }],
    ],
  ] as const) {
    it(`a rebound palette chord works from a focused terminal, and resets: ${system}`, async () => {
      os.mac = system === 'macOS'
      const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
      const onKey = (e: KeyboardEvent): void => {
        runAppChord(e, os.mac)
      }
      window.addEventListener('keydown', onKey)
      onTestFinished(() => {
        os.mac = false
        window.removeEventListener('keydown', onKey)
        exec.mockRestore()
      })
      const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
      await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
      const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      const opensPalette = (init: KeyboardEventInit): boolean => {
        exec.mockClear()
        fireEvent.keyDown(textarea, init)
        return exec.mock.calls.some(([id]) => id === 'palette.toggle')
      }

      act(() => useSettingsStore.setState({ keybindings: { 'palette.toggle': [...binding] } }))
      expect(opensPalette(dropped)).toBe(false)
      vi.mocked(window.ostia.pty.write).mockClear()
      expect(opensPalette(rebound)).toBe(true)
      expect(window.ostia.pty.write).not.toHaveBeenCalled()
      for (const init of kept) expect(opensPalette(init)).toBe(true)

      act(() => useSettingsStore.setState({ keybindings: {} }))
      expect(opensPalette(rebound)).toBe(false)
      expect(opensPalette(dropped)).toBe(true)
      for (const init of kept) expect(opensPalette(init)).toBe(true)
    })
  }

  it('OSC 52 sets the clipboard only while terminal.osc52Write is on', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    onTestFinished(() => {
      if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })
    act(() => useSettingsStore.getState().setTerminal({ osc52Write: true }))
    useLayoutStore.getState().ensure('w1')
    const { activePaneId } = useLayoutStore.getState().byWorkspace.w1
    await renderSettled(<TerminalView workspaceId="w1" paneId={activePaneId} />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    await act(async () => {
      await vi.mocked(window.ostia.pty.attach).mock.results[0]?.value
    })
    const deliver = vi.mocked(window.ostia.pty.onData).mock.calls[0][1]
    const term = terminalFor(activePaneId)
    const parsed = async (text: string): Promise<void> => {
      act(() => deliver(text))
      await act(() => new Promise<void>((resolve) => term?.write('', resolve)))
    }

    await parsed(`\x1b]52;c;${btoa('ostia-osc52')}\x07`)
    expect(writeText.mock.calls).toEqual([['ostia-osc52']])

    vi.mocked(window.ostia.pty.write).mockClear()
    await parsed('\x1b]52;c;?\x07')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(window.ostia.pty.write).not.toHaveBeenCalled()

    act(() => useSettingsStore.getState().setTerminal({ osc52Write: false }))
    await parsed(`\x1b]52;c;${btoa('ostia-off')}\x07`)
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('moving focus by direction puts the keyboard in the terminal it makes active', async () => {
    showWorkspace()
    const left = { ...createPane('terminal'), id: 'left' }
    const right = { ...createPane('terminal'), id: 'right' }
    useLayoutStore.setState({
      byWorkspace: {
        w1: {
          root: {
            type: 'split',
            id: 'sp',
            direction: 'horizontal',
            children: [left, right],
            sizes: [1, 1],
          },
          activePaneId: 'right',
          zoomedPaneId: null,
        },
      },
    })
    const hosts = { left: surfaceHost('left'), right: surfaceHost('right') }
    document.body.append(hosts.left, hosts.right)
    onTestFinished(() => releaseSurfaces(new Set()))
    await renderSettled(
      <>
        {createPortal(<TerminalView workspaceId="w1" paneId="left" />, hosts.left)}
        {createPortal(<TerminalView workspaceId="w1" paneId="right" />, hosts.right)}
      </>,
    )
    const input = (paneId: 'left' | 'right'): HTMLElement =>
      hosts[paneId].querySelector('.xterm-helper-textarea') as HTMLElement
    input('right').focus()

    act(() => {
      focusPaneInDirection('w1', 'right', 'left')
    })
    expect(useLayoutStore.getState().byWorkspace.w1.activePaneId).toBe('left')
    await waitFor(() => expect(input('left')).toHaveFocus())

    act(() => {
      focusPaneInDirection('w1', 'left', 'right')
    })
    await waitFor(() => expect(input('right')).toHaveFocus())
  })

  it('a multi-line paste into an xterm terminal asks first; Cancel pastes nothing, Paste pastes', async () => {
    const user = userEvent.setup()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(window.ostia.pty.attach).toHaveBeenCalled())
    const input = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    input.focus()

    await navigator.clipboard.writeText('echo ostiacancelled\necho two\n')
    await user.keyboard('{Control>}{Shift>}V{/Shift}{/Control}')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('It has 2 lines')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.ostia.pty.write).not.toHaveBeenCalled()

    await navigator.clipboard.writeText('echo ostiafirst\necho ostiapasted42')
    await user.keyboard('{Control>}{Shift>}V{/Shift}{/Control}')
    await screen.findByRole('dialog')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Paste' }))
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith(
        'p1',
        expect.stringContaining('echo ostiafirst\recho ostiapasted42'),
        'paste',
      ),
    )
  })

  it('a link’s hint in a mouse-reporting program offers Ctrl+Click and leaves plain clicks to the program', async () => {
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
    const box = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 }))
    onTestFinished(() => {
      fitted.mockRestore()
      box.mockRestore()
    })
    const { term, links } = await renderLinkTerminal()
    await act(() => new Promise<void>((done) => term.write('\x1b[?1000h\x1b[?1006h', done)))
    expect(term.modes.mouseTrackingMode).not.toBe('none')

    act(() => links.hover?.(new MouseEvent('mousemove'), 'http://127.0.0.1:8000/osc', linkRange))
    const hint = await waitFor(() => {
      const shown = document.querySelector('[data-slot="tooltip-content"]')
      expect(shown).not.toBeNull()
      return shown as HTMLElement
    })
    expect(hint).toHaveTextContent('Ctrl+Click Open in a new browser tab')
    expect(hint).not.toHaveTextContent('Open in the browser pane')

    act(() => links.activate(click(), 'http://127.0.0.1:8000/osc', linkRange))
    expect(browserUrls()).toEqual([])
  })

  it('a link’s hover hint goes away when another tab of its stack is shown', async () => {
    const fitted = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue(undefined)
    const box = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 }))
    onTestFinished(() => {
      fitted.mockRestore()
      box.mockRestore()
    })
    showWorkspace()
    const linked = { ...createPane('terminal'), id: 'linked' }
    const other = { ...createPane('terminal'), id: 'other' }
    useLayoutStore.setState({
      byWorkspace: {
        w1: { root: tabsOf('linked', linked, other), activePaneId: 'linked', zoomedPaneId: null },
      },
    })
    await renderSettled(<TerminalView workspaceId="w1" paneId="linked" />)
    const links = (terminalFor('linked') as unknown as Xterm).options.linkHandler as ILinkHandler
    const hint = (): Element | null => document.querySelector('[data-slot="tooltip-content"]')

    act(() => links.hover?.(new MouseEvent('mousemove'), 'slack://channel?id=1', linkRange))
    await waitFor(() => expect(hint()).not.toBeNull())

    act(() => useLayoutStore.getState().focusPane('w1', 'other'))
    expect(hint()).toBeNull()
  })

  it('a tab closes when its shell exits by itself, unless the human locked it', async () => {
    showWorkspace()
    const kept = { ...createPane('terminal'), id: 'kept' }
    const own = { ...createPane('terminal'), id: 'own' }
    const locked = { ...createPane('terminal'), id: 'locked' }
    useLayoutStore.setState({
      byWorkspace: {
        w1: { root: tabsOf('own', kept, own, locked), activePaneId: 'own', zoomedPaneId: null },
      },
    })
    act(() => useLayoutStore.getState().setLocked('w1', 'locked', true))
    await renderSettled(
      <>
        <TerminalView workspaceId="w1" paneId="own" />
        <TerminalView workspaceId="w1" paneId="locked" />
      </>,
    )
    const exitOf = (paneId: string) => {
      const call = vi.mocked(window.ostia.pty.onExit).mock.calls.find(([id]) => id === paneId)
      if (!call) throw new Error(`no exit listener for ${paneId}`)
      return call[1]
    }
    const tabIds = () => allPanes(useLayoutStore.getState().byWorkspace.w1.root).map((p) => p.id)

    act(() => exitOf('own')(0, false))
    expect(tabIds()).toEqual(['kept', 'own', 'locked'])
    act(() => exitOf('own')(1, true))
    expect(tabIds()).toEqual(['kept', 'locked'])

    act(() => exitOf('locked')(0, true))
    expect(tabIds()).toEqual(['kept', 'locked'])
    const lockedTerm = terminalFor('locked') as unknown as Xterm
    await act(() => new Promise<void>((done) => lockedTerm.write('', done)))
    const text = Array.from(
      { length: lockedTerm.buffer.active.length },
      (_, i) => lockedTerm.buffer.active.getLine(i)?.translateToString(true) ?? '',
    ).join('')
    expect(text).toContain('[process exited]')
  })
})
