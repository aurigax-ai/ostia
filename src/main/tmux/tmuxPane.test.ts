import { describe, expect, it, vi } from 'vitest'
import { TmuxPane } from './tmuxPane'

describe('TmuxPane foreground', () => {
  it('runs a waiter once, after the next foreground update', () => {
    const pane = new TmuxPane({} as never, 'w1', '%1', 1, 80, 24)
    const waiter = vi.fn()
    pane.afterForeground(waiter)
    expect(waiter).not.toHaveBeenCalled()
    pane.setForeground('zsh')
    expect(pane.process).toBe('zsh')
    expect(waiter).toHaveBeenCalledTimes(1)
    pane.setForeground('claude')
    expect(waiter).toHaveBeenCalledTimes(1)
  })
})
