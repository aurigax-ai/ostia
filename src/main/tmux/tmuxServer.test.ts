import { describe, expect, it } from 'vitest'
import { parseExit } from './tmuxServer'

describe('parseExit', () => {
  it('reads the exit status, or 128 plus the signal, of a dead pane', () => {
    expect(parseExit('1:7:')).toBe(7)
    expect(parseExit('1:0:')).toBe(0)
    expect(parseExit('1::9')).toBe(137)
  })

  it('KSH-C69 waits while tmux knows the pane is dead but has not reaped its process', () => {
    expect(parseExit('1::')).toBeNull()
  })

  it('ignores a live pane', () => {
    expect(parseExit('0::')).toBeNull()
  })
})
