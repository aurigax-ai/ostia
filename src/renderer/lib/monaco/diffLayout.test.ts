import { describe, expect, it } from 'vitest'
import { INLINE_BELOW_PX, isInlineDiff } from './diffLayout'

describe('isInlineDiff', () => {
  it('auto is side by side until the pane is narrower than the breakpoint', () => {
    expect(isInlineDiff('auto', INLINE_BELOW_PX)).toBe(false)
    expect(isInlineDiff('auto', INLINE_BELOW_PX - 1)).toBe(true)
    expect(isInlineDiff('auto', 2000)).toBe(false)
  })

  it('auto stays side by side before the pane has been measured', () => {
    expect(isInlineDiff('auto', 0)).toBe(false)
  })

  it('a chosen layout ignores the width', () => {
    expect(isInlineDiff('sideBySide', 300)).toBe(false)
    expect(isInlineDiff('inline', 3000)).toBe(true)
  })
})
