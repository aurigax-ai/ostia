import '@testing-library/jest-dom/vitest'
import { loadGhostty } from '@/lib/terminal/ghosttyEngine'
import { createFileLinkProvider } from '@/lib/terminal/terminalFileLinks'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useEditorRevealStore } from '@/stores/files/editorRevealStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  type RenderResult,
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import type { ReactElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
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

vi.mock('@/lib/terminal/terminalFileLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal/terminalFileLinks')>()
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

describe('TerminalView engines', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
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
    vi.clearAllMocks()
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

  it('keeps xterm.js for a terminal opened before the switch', async () => {
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    act(() => useGhostty())
    expect(container.querySelector('.xterm-host')).not.toBeNull()
    expect(container.querySelector('.ghostty-host')).toBeNull()
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
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'echo pasted_$((6*7))'),
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

    const before = fontSize()
    scroll(-100)
    expect(fontSize()).toBeGreaterThan(before)

    const zoomed = fontSize()
    scroll(100)
    expect(fontSize()).toBeLessThan(zoomed)
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
      expect(vi.mocked(window.ostia.pty.write).mock.calls).toEqual(sent.map((data) => ['p1', data]))
    })
  }

  it('smart Ctrl+V hands an image-only clipboard to the program as Ctrl+V', async () => {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, clipboardKeys: 'smart' },
    })
    vi.mocked(window.ostia.clipboard.hasImage).mockResolvedValueOnce(true)
    const user = userEvent.setup()
    const { container } = await renderSettled(<TerminalView workspaceId="w1" paneId="p1" />)
    const textarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    act(() => textarea.focus())
    await user.keyboard('{Control>}v{/Control}')
    await waitFor(() => expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', '\x16'))
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
    it(`${engine}: Ctrl+click reveals a folder in Files, opens an outside folder in the file manager and opens an outside file`, async () => {
      useFileTreeStore.setState({ revealed: null })
      useUIStore.setState({ filesOpen: false })
      useEditorRevealStore.setState({ pending: {} })
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
      vi.mocked(window.ostia.terminalLinks.openFolder).mockResolvedValue({ ok: true })
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
        const ctrlClick = (link: ILink): void => {
          act(() => link.activate({ ctrlKey: true, isTrusted: true } as MouseEvent, link.text))
        }

        const inside = await linkOn(1)
        hover(inside)
        await waitFor(() => expect(hint()).toHaveTextContent('Ctrl+Click Show the folder in Files'))
        ctrlClick(inside)
        expect(useFileTreeStore.getState().revealed).toEqual({
          root: '/home/me',
          path: '/home/me/notes/sub',
        })
        expect(useUIStore.getState().filesOpen).toBe(true)
        expect(window.ostia.terminalLinks.openFolder).not.toHaveBeenCalled()

        const folder = await linkOn(2)
        hover(folder)
        await waitFor(() =>
          expect(hint()).toHaveTextContent('Ctrl+Click Open the folder in the file manager'),
        )
        act(() => folder.activate({ ctrlKey: false, isTrusted: true } as MouseEvent, folder.text))
        expect(window.ostia.terminalLinks.openFolder).not.toHaveBeenCalled()
        ctrlClick(folder)
        expect(window.ostia.terminalLinks.openFolder).toHaveBeenCalledWith('p1', '/out/shots')

        const file = await linkOn(3)
        hover(file)
        await waitFor(() => expect(hint()).toHaveTextContent('Ctrl+Click Open the file'))
        ctrlClick(file)
        await waitFor(() =>
          expect(openFile).toHaveBeenCalledWith(expect.any(String), '/out/shots/report.txt'),
        )
        expect(useEditorRevealStore.getState().pending['/out/shots/report.txt']).toEqual({
          line: 7,
          column: 1,
        })
        expect(window.ostia.terminalLinks.admit).toHaveBeenCalledWith('p1', '/out/shots/report.txt')
        expect(window.ostia.terminalLinks.openFolder).toHaveBeenCalledTimes(1)
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
      expect(window.ostia.pty.write).toHaveBeenCalledWith('p1', 'echo ostiaplain'),
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => useSettingsStore.getState().setTerminal({ warnOnRiskyPaste: false }))
    await navigator.clipboard.writeText('\necho ostiaquiet77\n')
    await user.keyboard('{Control>}{Shift>}V{/Shift}{/Control}')
    await waitFor(() =>
      expect(window.ostia.pty.write).toHaveBeenCalledWith(
        'p1',
        expect.stringContaining('echo ostiaquiet77'),
      ),
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lowering scrollback in Settings trims history in an open terminal', async () => {
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
})
