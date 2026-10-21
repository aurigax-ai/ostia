import { describe, expect, it, vi } from 'vitest'
import { followHash, type HashWindow } from './pdfSeed'

function fakeWindow(hash: string) {
  const listeners: (() => void)[] = []
  const win = {
    location: { hash, pathname: '/pdf.html', search: '' },
    history: {
      replaceState: vi.fn((_state: null, _title: string, url: string) => {
        win.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''
      }),
    },
    addEventListener: (_type: 'hashchange', listener: () => void) => listeners.push(listener),
  } satisfies HashWindow
  const navigate = (next: string) => {
    win.location.hash = next
    for (const listener of listeners) listener()
  }
  return { win, navigate }
}

describe('followHash', () => {
  it('goes to the page and starts the find the address names, then clears the address', () => {
    const { win } = fakeWindow('#page=4&find=needle')
    const target = { goTo: vi.fn(), find: vi.fn() }
    followHash(win, target)
    expect(target.goTo).toHaveBeenCalledWith(4)
    expect(target.find).toHaveBeenCalledWith('needle')
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/pdf.html')
    expect(win.location.hash).toBe('')
  })

  it('does nothing for an address without a hint', () => {
    const { win } = fakeWindow('')
    const target = { goTo: vi.fn(), find: vi.fn() }
    followHash(win, target)
    expect(target.goTo).not.toHaveBeenCalled()
    expect(win.history.replaceState).not.toHaveBeenCalled()
  })

  it('follows a hint that arrives while the page is open, once each', () => {
    const { win, navigate } = fakeWindow('')
    const target = { goTo: vi.fn(), find: vi.fn() }
    followHash(win, target)
    navigate('#page=2&find=first')
    navigate('#page=7')
    expect(target.goTo.mock.calls).toEqual([[2], [7]])
    expect(target.find.mock.calls).toEqual([['first']])
    expect(win.location.hash).toBe('')
    navigate('')
    expect(target.goTo).toHaveBeenCalledTimes(2)
  })
})
