import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWindowCoverReport } from './windowCover'

describe('window cover report', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('tells main when the page becomes hidden or visible again', () => {
    const cover = vi.fn()
    vi.stubGlobal('ostia', { pty: { cover } })
    Object.assign(window, { ostia: { pty: { cover } } })
    let state: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state)
    const stop = startWindowCoverReport()
    expect(cover).toHaveBeenLastCalledWith(false)
    state = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cover).toHaveBeenLastCalledWith(true)
    state = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cover).toHaveBeenLastCalledWith(false)
    stop()
    state = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cover).toHaveBeenCalledTimes(3)
  })
})
