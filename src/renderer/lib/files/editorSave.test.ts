import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutoSave, saveFormatted } from './editorSave'

describe('createAutoSave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves once, one delay after the last edit', () => {
    const save = vi.fn()
    const auto = createAutoSave(save, 1000)
    auto.schedule()
    vi.advanceTimersByTime(600)
    auto.schedule()
    vi.advanceTimersByTime(600)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(400)
    expect(save).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not save after cancel', () => {
    const save = vi.fn()
    const auto = createAutoSave(save, 1000)
    auto.schedule()
    auto.cancel()
    vi.advanceTimersByTime(2000)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('saveFormatted', () => {
  it('formats before writing when format on save is on', async () => {
    const order: string[] = []
    const ok = await saveFormatted({
      formatOnSave: true,
      format: async () => void order.push('format'),
      write: async () => {
        order.push('write')
        return true
      },
    })
    expect(order).toEqual(['format', 'write'])
    expect(ok).toBe(true)
  })

  it('only writes when format on save is off', async () => {
    const format = vi.fn(async () => undefined)
    await saveFormatted({ formatOnSave: false, format, write: async () => true })
    expect(format).not.toHaveBeenCalled()
  })

  it('still writes when formatting fails', async () => {
    const write = vi.fn(async () => true)
    await saveFormatted({
      formatOnSave: true,
      format: () => Promise.reject(new Error('no formatter')),
      write,
    })
    expect(write).toHaveBeenCalledTimes(1)
  })
})
