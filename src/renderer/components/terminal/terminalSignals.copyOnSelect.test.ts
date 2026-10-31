import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCaptureStore } from '@/lib/capture/captureSession'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { createTerminalSession } from './terminalSession'
import { attachTerminalSignals } from './terminalSignals'

let host: HTMLElement
let select: () => void
let initial: ReturnType<typeof useSettingsStore.getState>

function attach(): () => void {
  const handle = { dispose: () => undefined }
  const term = {
    parser: { registerOscHandler: () => handle },
    onSelectionChange: (cb: () => void) => {
      select = cb
      return handle
    },
    onTitleChange: () => handle,
    onBell: () => handle,
    hasSelection: () => true,
    getSelection: () => 'picked',
    options: { theme: { foreground: '#123456' } },
  } as unknown as Parameters<typeof attachTerminalSignals>[0]['term']
  return attachTerminalSignals({
    host,
    term,
    paneId: 'p1',
    workspaceIdRef: { current: 'w1' },
    session: createTerminalSession(null),
  })
}

const chip = () => useCaptureStore.getState().chip.p1?.label

beforeEach(() => {
  initial = useSettingsStore.getState()
  useSettingsStore.setState({ behavior: { ...initial.behavior, copyOnSelect: true } })
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
  window.ostia = { window: { beep: vi.fn() } } as unknown as typeof window.ostia
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  useSettingsStore.setState(initial, true)
  useCaptureStore.setState({ open: {}, status: {}, chip: {} })
  vi.unstubAllGlobals()
  host.remove()
})

describe('copy on select', () => {
  it('shows the Copied chip once when the mouse button is released, never during the drag', () => {
    attach()
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select()
    select()
    expect(chip()).toBeUndefined()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(chip()).toBe('Copied')
  })

  it('shows no chip for a selection made without the mouse', () => {
    attach()
    select()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(chip()).toBeUndefined()
  })

  it('shows no chip when copy on select is off', () => {
    useSettingsStore.setState({ behavior: { ...initial.behavior, copyOnSelect: false } })
    attach()
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(chip()).toBeUndefined()
  })

  it('stops listening once detached', () => {
    const detach = attach()
    detach()
    host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select()
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(chip()).toBeUndefined()
  })
})
