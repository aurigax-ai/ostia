import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { ghosttyKeyAction } from './GhosttyTerminal'
import { TerminalView } from './Terminal'

const fake = vi.hoisted(() => {
  class FakeTerminal {
    static last: FakeTerminal | null = null
    cols = 100
    rows = 30
    options: Record<string, unknown>
    written: string[] = []
    pasted: string[] = []
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null
    private dataListener: ((d: string) => void) | null = null
    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeTerminal.last = this
    }
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      parent.appendChild(document.createElement('textarea'))
    }
    write(data: string, cb?: () => void): void {
      this.written.push(data)
      cb?.()
    }
    writeln(data: string): void {
      this.written.push(`${data}\n`)
    }
    paste(data: string): void {
      this.pasted.push(data)
    }
    input(data: string): void {
      this.dataListener?.(data)
    }
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    focus(): void {}
    dispose(): void {}
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      this.keyHandler = handler
    }
    onData(listener: (d: string) => void) {
      this.dataListener = listener
      return { dispose: () => {} }
    }
    onTitleChange() {
      return { dispose: () => {} }
    }
    onSelectionChange() {
      return { dispose: () => {} }
    }
  }
  class FakeFit {
    fit(): void {}
  }
  return { FakeTerminal, FakeFit }
})

vi.mock('ghostty-web', () => ({
  Ghostty: { load: async () => ({}) },
  Terminal: fake.FakeTerminal,
  FitAddon: fake.FakeFit,
}))

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

function key(init: KeyboardEventInit & { key: string; code?: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('TerminalView with the Ghostty engine', () => {
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    settingsInit = useSettingsStore.getState()
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    fake.FakeTerminal.last = null
    vi.clearAllMocks()
  })

  function useGhostty(): void {
    useSettingsStore.setState({
      terminal: { ...useSettingsStore.getState().terminal, renderer: 'ghostty' },
    })
  }

  it('draws a new terminal with Ghostty and starts its shell at the fitted size', async () => {
    useGhostty()
    vi.mocked(window.ostia.pty.attach).mockResolvedValue({
      created: true,
      buffer: 'hello',
      cursor: 0,
      dropped: false,
    })
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" cwd="/home/me" />)
    expect(container.querySelector('[data-terminal-renderer="ghostty"]')).not.toBeNull()
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cols: 100, rows: 30, cwd: '/home/me', role: 'owner' }),
      ),
    )
    await waitFor(() => expect(fake.FakeTerminal.last?.written).toContain('hello'))
  })

  it('keeps xterm for a pane opened before the switch', () => {
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" />)
    act(() => useGhostty())
    expect(container.querySelector('[data-terminal-renderer="ghostty"]')).toBeNull()
    expect(container.querySelector('.xterm-host')).not.toBeNull()
  })

  it('asks before pasting several lines', async () => {
    useGhostty()
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" />)
    await waitFor(() => expect(fake.FakeTerminal.last).not.toBeNull())
    const textarea = container.querySelector('textarea')
    if (!textarea) throw new Error('no textarea')
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'rm -rf build\nmake' },
    })
    act(() => {
      textarea.dispatchEvent(paste)
    })
    expect(await screen.findByRole('button', { name: 'Paste' })).toBeVisible()
    expect(fake.FakeTerminal.last?.pasted).toEqual([])
  })
})

describe('ghosttyKeyAction', () => {
  it('leaves plain keys to Ghostty and keeps Ctrl+V for the shell on Linux', () => {
    expect(ghosttyKeyAction(key({ key: 'a', code: 'KeyA' }), false, 'shift', false)).toEqual({
      kind: 'pass',
    })
    expect(
      ghosttyKeyAction(key({ key: 'v', code: 'KeyV', ctrlKey: true }), false, 'shift', false),
    ).toEqual({ kind: 'send', data: '\x16' })
  })

  it('copies and pastes on the app chords and swallows other app chords', () => {
    const copy = key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    const paste = key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true })
    const palette = key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(ghosttyKeyAction(copy, true, 'shift', false)).toEqual({ kind: 'copy' })
    expect(ghosttyKeyAction(paste, false, 'shift', false)).toEqual({ kind: 'paste' })
    expect(ghosttyKeyAction(palette, false, 'shift', false)).toEqual({ kind: 'swallow' })
  })

  it('copies on Ctrl+C only with a selection in smart clipboard mode', () => {
    const ctrlC = key({ key: 'c', code: 'KeyC', ctrlKey: true })
    expect(ghosttyKeyAction(ctrlC, true, 'smart', false)).toEqual({ kind: 'copy' })
    expect(ghosttyKeyAction(ctrlC, false, 'smart', false)).toEqual({ kind: 'pass' })
  })
})
