import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneWaking } from './paneWaking'

const never = () => ({ dispose: () => {} })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PaneWaking', () => {
  it('holds a pane from its wake until it ends, once', () => {
    const waking = new PaneWaking()
    expect(waking.has('p1')).toBe(false)
    waking.start('p1')
    expect(waking.has('p1')).toBe(true)
    waking.end('p1', 'started')
    expect(waking.has('p1')).toBe(false)
  })

  it('answers started at once for panes that are not waking', async () => {
    const waking = new PaneWaking()
    await expect(waking.until(['p1'], 1000, never)).resolves.toEqual({ how: 'started' })
  })

  it('answers started only after every pane started', async () => {
    const waking = new PaneWaking()
    waking.start('p1')
    waking.start('p2')
    const done = vi.fn()
    void waking.until(['p1', 'p2'], 60_000, never).then(done)
    waking.end('p1', 'started')
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    waking.end('p2', 'started')
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ how: 'started' }))
  })

  it('answers the first pane that failed or closed', async () => {
    const waking = new PaneWaking()
    waking.start('p1')
    waking.start('p2')
    const ended = waking.until(['p1', 'p2'], 60_000, never)
    waking.end('p2', 'closed')
    await expect(ended).resolves.toEqual({ how: 'closed', paneId: 'p2' })
    waking.start('p3')
    const failed = waking.until(['p3'], 60_000, never)
    waking.end('p3', 'failed')
    await expect(failed).resolves.toEqual({ how: 'failed', paneId: 'p3' })
  })

  it('ignores panes it does not wait on, and an end for a pane that is not waking', async () => {
    const waking = new PaneWaking()
    waking.start('p1')
    waking.start('other')
    const done = vi.fn()
    void waking.until(['p1'], 60_000, never).then(done)
    waking.end('other', 'failed')
    waking.end('nobody', 'failed')
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    waking.end('p1', 'started')
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ how: 'started' }))
  })

  it('times out, and stops when the caller goes away', async () => {
    const waking = new PaneWaking()
    waking.start('p1')
    const timedOut = waking.until(['p1'], 1000, never)
    vi.advanceTimersByTime(1000)
    await expect(timedOut).resolves.toEqual({ how: 'timeout' })
    expect(waking.has('p1')).toBe(true)

    let cancel = (): void => {}
    const dispose = vi.fn()
    const gone = waking.until(['p1'], 60_000, (fn) => {
      cancel = fn
      return { dispose }
    })
    cancel()
    await expect(gone).resolves.toEqual({ how: 'timeout' })
    expect(dispose).toHaveBeenCalled()
  })
})
