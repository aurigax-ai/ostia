import { describe, expect, it, vi } from 'vitest'
import {
  type BrowserHandle,
  browserActionOf,
  browserHandleFor,
  browserPaneOfGuest,
  registerBrowserHandle,
  runBrowserAction,
} from './browserHandles'

function handle(guestId: number | null): BrowserHandle {
  return {
    guestId: () => guestId,
    focusAddress: vi.fn(),
    reload: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    find: vi.fn(),
  }
}

describe('browser handles', () => {
  it('runs an action on the pane that registered it and finds the pane of a guest', () => {
    const h = handle(42)
    const off = registerBrowserHandle('b1', h)
    expect(browserHandleFor('b1')).toBe(h)
    expect(browserPaneOfGuest(42)).toBe('b1')
    expect(browserPaneOfGuest(43)).toBeNull()
    expect(runBrowserAction('b1', 'reload')).toBe(true)
    expect(h.reload).toHaveBeenCalled()
    expect(runBrowserAction('b2', 'reload')).toBe(false)
    off()
    expect(browserHandleFor('b1')).toBeUndefined()
  })

  it('keeps a newer handle when an older one unregisters', () => {
    const older = handle(1)
    const newer = handle(2)
    const off = registerBrowserHandle('b1', older)
    registerBrowserHandle('b1', newer)
    off()
    expect(browserHandleFor('b1')).toBe(newer)
  })

  it('maps browser chords and the find chord to actions', () => {
    expect(browserActionOf('browser.focusAddress')).toBe('focusAddress')
    expect(browserActionOf('browser.back')).toBe('back')
    expect(browserActionOf('find')).toBe('find')
    expect(browserActionOf('palette.toggle')).toBeNull()
    expect(browserActionOf('toString')).toBeNull()
  })
})
