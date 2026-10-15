import { describe, expect, it } from 'vitest'
import { initialTerminalOptions } from './useTerminalOptions'

describe('initialTerminalOptions', () => {
  it('starts every engine with scrollback animation off', () => {
    expect(initialTerminalOptions().smoothScrollDuration).toBe(0)
  })
})
