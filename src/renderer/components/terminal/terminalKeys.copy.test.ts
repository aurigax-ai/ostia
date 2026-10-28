import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCaptureStore } from '@/lib/capture/captureSession'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { attachTerminalKeys } from './terminalKeys'

type KeyHandler = (e: KeyboardEvent) => boolean

function mount(selection: string) {
  let handler: KeyHandler = () => true
  const term = {
    attachCustomKeyEventHandler: (fn: KeyHandler) => {
      handler = fn
    },
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    clearSelection: vi.fn(),
  } as unknown as OstiaTerminal
  const host = document.createElement('div')
  attachTerminalKeys({
    host,
    term,
    paneId: 'p1',
    pasteFromClipboard: vi.fn(),
    setFindOpen: vi.fn(),
    findStepRef: { current: null },
  })
  const press = (init: KeyboardEventInit): void => {
    handler(new KeyboardEvent('keydown', { cancelable: true, ...init }))
  }
  return { host, press }
}

const chip = () => useCaptureStore.getState().chip.p1?.label

beforeEach(() => {
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  useCaptureStore.setState({ open: {}, status: {}, chip: {} })
  useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, clipboardKeys: 'shift' } }))
})

describe('terminal copy chords', () => {
  it('shows the Copied chip for Ctrl+Shift+C', async () => {
    const { press } = mount('hello')
    press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })
    await vi.waitFor(() => expect(chip()).toBe('Copied'))
  })

  it('shows the Copied chip for smart Ctrl+C on a selection', async () => {
    useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, clipboardKeys: 'smart' } }))
    const { press } = mount('hello')
    press({ key: 'c', code: 'KeyC', ctrlKey: true })
    await vi.waitFor(() => expect(chip()).toBe('Copied'))
  })

  it('shows the Copied chip for a native copy event on a selection', () => {
    const { host } = mount('hello')
    host.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(chip()).toBe('Copied')
  })

  it('shows no chip for a native copy without a selection', () => {
    const { host } = mount('')
    host.dispatchEvent(new Event('copy', { bubbles: true }))
    expect(chip()).toBeUndefined()
  })
})
