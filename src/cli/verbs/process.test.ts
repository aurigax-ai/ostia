import { describe, expect, it } from 'vitest'
import { processHintLine } from './process'

describe('processHintLine', () => {
  it('prefixes the hint with the process name', () => {
    expect(
      processHintLine({ name: 'web', hint: 'macOS Gatekeeper may have ended this process' }),
    ).toBe('web: macOS Gatekeeper may have ended this process')
  })

  it('prints nothing without a hint', () => {
    expect(processHintLine({ name: 'web' })).toBeNull()
  })
})
