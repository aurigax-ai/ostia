import { describe, expect, it } from 'vitest'
import { PRIMARY_SELECTION_MAX_CHARS, acceptsPrimarySelection } from './primarySelection'

describe('acceptsPrimarySelection', () => {
  it('takes non-empty text up to the cap, only on Linux', () => {
    expect(acceptsPrimarySelection('linux', 'ls -la')).toBe(true)
    expect(acceptsPrimarySelection('darwin', 'ls -la')).toBe(false)
    expect(acceptsPrimarySelection('linux', '')).toBe(false)
    expect(acceptsPrimarySelection('linux', 42)).toBe(false)
    expect(acceptsPrimarySelection('linux', 'x'.repeat(PRIMARY_SELECTION_MAX_CHARS + 1))).toBe(
      false,
    )
  })
})
