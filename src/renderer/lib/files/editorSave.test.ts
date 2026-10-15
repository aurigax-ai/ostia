import { describe, expect, it, vi } from 'vitest'
import { saveFormatted } from './editorSave'

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
