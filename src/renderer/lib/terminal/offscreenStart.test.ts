import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forgetOffscreenStart,
  noteFittedGrid,
  offscreenGrid,
  registerOffscreenStarter,
  resetOffscreenStartForTests,
  startOffscreen,
} from './offscreenStart'

afterEach(() => resetOffscreenStartForTests())

describe('offscreen start', () => {
  it('starts a terminal that is already on the page at once', () => {
    const start = vi.fn()
    registerOffscreenStarter('p1', start)
    startOffscreen('p1')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('remembers the request until the terminal for that pane registers', () => {
    startOffscreen('p2')
    const other = vi.fn()
    registerOffscreenStarter('p-other', other)
    expect(other).not.toHaveBeenCalled()
    const start = vi.fn()
    registerOffscreenStarter('p2', start)
    expect(start).toHaveBeenCalledTimes(1)
    registerOffscreenStarter('p2', start)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('stops calling a terminal that went away, and drops a forgotten request', () => {
    const start = vi.fn()
    const unregister = registerOffscreenStarter('p3', start)
    unregister()
    startOffscreen('p3')
    expect(start).not.toHaveBeenCalled()
    forgetOffscreenStart('p3')
    registerOffscreenStarter('p3', start)
    expect(start).not.toHaveBeenCalled()
  })

  it('sizes an offscreen terminal like the last one that fitted on screen', () => {
    expect(offscreenGrid()).toEqual({ cols: 80, rows: 24 })
    noteFittedGrid(132, 41)
    noteFittedGrid(0, 10)
    expect(offscreenGrid()).toEqual({ cols: 132, rows: 41 })
  })
})
