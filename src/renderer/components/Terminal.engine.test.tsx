import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { TerminalView } from './Terminal'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const realGetContext = HTMLCanvasElement.prototype.getContext

function useGhostty(): void {
  useSettingsStore.setState({
    terminal: { ...useSettingsStore.getState().terminal, renderer: 'ghostty' },
  })
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
  })

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    vi.clearAllMocks()
  })

  it('draws a new terminal with Ghostty and starts its shell through the shared path', async () => {
    useGhostty()
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" cwd="/home/me" />)
    await waitFor(() => expect(container.querySelector('.ghostty-host canvas')).not.toBeNull())
    expect(container.querySelector('.ghostty-screen')).not.toBeNull()
    await waitFor(() =>
      expect(window.ostia.pty.attach).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ cwd: '/home/me', role: 'owner' }),
      ),
    )
  })

  it('keeps xterm.js for a terminal opened before the switch', () => {
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" />)
    act(() => useGhostty())
    expect(container.querySelector('.xterm-host')).not.toBeNull()
    expect(container.querySelector('.ghostty-host')).toBeNull()
  })

  it('asks before pasting several lines into a Ghostty terminal', async () => {
    useGhostty()
    const { container } = render(<TerminalView workspaceId="w1" paneId="p1" />)
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
})
