import { describe, expect, it, vi } from 'vitest'
import { ShellStops } from './shellStops'

describe('ShellStops', () => {
  it('REM-U45 stops a shell, and one that failed while offline when the host is back', async () => {
    const stop = vi.fn(async () => {})
    stop.mockRejectedValueOnce(new Error('offline'))
    const stops = new ShellStops(stop)

    await stops.stop('box', '0123abcd')
    await stops.retry('other')
    expect(stop).toHaveBeenCalledTimes(1)

    await stops.retry('box')
    expect(stop).toHaveBeenLastCalledWith('box', '0123abcd')
    expect(stop).toHaveBeenCalledTimes(2)

    await stops.retry('box')
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
