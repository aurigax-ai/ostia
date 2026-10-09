import { describe, expect, it } from 'vitest'
import { STARTUP_FAILURE_MS, closesPaneOnExit } from './shellExit'

describe('closesPaneOnExit', () => {
  it('closes the pane when the shell ends by itself, whatever its last command returned', () => {
    expect(closesPaneOnExit({ ownExit: true, code: 0, livedMs: 10 })).toBe(true)
    expect(closesPaneOnExit({ ownExit: true, code: 127, livedMs: STARTUP_FAILURE_MS })).toBe(true)
  })

  it('keeps the pane when the shell failed right after starting, so its error stays readable', () => {
    expect(closesPaneOnExit({ ownExit: true, code: 1, livedMs: STARTUP_FAILURE_MS - 1 })).toBe(
      false,
    )
  })

  it('keeps the pane when Ostia itself stopped the shell', () => {
    expect(closesPaneOnExit({ ownExit: false, code: 0, livedMs: 60_000 })).toBe(false)
  })
})
