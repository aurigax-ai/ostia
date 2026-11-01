import { afterEach, describe, expect, it, vi } from 'vitest'
import { setErrorSink } from '../diagnostics/errorReport'
import { waitFor } from './browseMethod'

afterEach(() => setErrorSink(null))

describe('waitFor', () => {
  it('keeps polling through a failing check and succeeds once it passes', async () => {
    let calls = 0
    const ok = await waitFor(async () => {
      calls += 1
      if (calls < 3) throw new Error('page is navigating')
      return true
    }, 2000)
    expect(ok).toBe(true)
  })

  it('reports the last failure when the wait times out', async () => {
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() })
    const ok = await waitFor(async () => {
      throw new ReferenceError('gone')
    }, 0)
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith('unexpected-error', {
      scope: 'browseWait',
      name: 'ReferenceError',
      code: undefined,
    })
  })
})
