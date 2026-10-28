import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CaptureAdapter, openCapture, useCaptureStore } from './captureSession'
import { confirmNativeCopy, copyTextConfirmed } from './copyConfirm'

const adapter = (): CaptureAdapter => ({
  anchor: null,
  takeFocus: false,
  highlight: null,
  copy: async () => ({ ok: true, label: 'Copied' }),
  send: async () => ({ ok: true, inserted: false }),
  clear: () => undefined,
})

afterEach(() => {
  vi.unstubAllGlobals()
  useCaptureStore.setState({ open: {}, status: {}, chip: {} })
})

describe('copyTextConfirmed', () => {
  it('writes the text and shows the Copied chip without opening a bar', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } })
    expect(await copyTextConfirmed('p1', 'echo hi')).toBe(true)
    expect(write).toHaveBeenCalledWith('echo hi')
    const state = useCaptureStore.getState()
    expect(state.chip.p1?.label).toBe('Copied')
    expect(state.open.p1).toBeUndefined()
  })

  it('closes an open bar with the chip', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const clear = vi.fn()
    openCapture('p1', { ...adapter(), clear })
    await copyTextConfirmed('p1', 'x')
    expect(useCaptureStore.getState().open.p1).toBeUndefined()
    expect(clear).toHaveBeenCalledWith('copied')
    expect(useCaptureStore.getState().chip.p1?.label).toBe('Copied')
  })

  it('shows no chip when the clipboard write fails', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    expect(await copyTextConfirmed('p1', 'x')).toBe(false)
    expect(useCaptureStore.getState().chip.p1).toBeUndefined()
  })
})

describe('confirmNativeCopy', () => {
  it('shows the chip for a native copy with no capture open', () => {
    confirmNativeCopy('p1')
    expect(useCaptureStore.getState().chip.p1?.label).toBe('Copied')
  })

  it('leaves an open capture to the capture copy path', () => {
    openCapture('p1', adapter())
    confirmNativeCopy('p1')
    expect(useCaptureStore.getState().open.p1).toBeDefined()
    expect(useCaptureStore.getState().chip.p1).toBeUndefined()
  })
})
