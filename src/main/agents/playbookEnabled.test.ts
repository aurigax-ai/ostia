import { describe, expect, it } from 'vitest'
import { playbookEnabled } from './playbookEnabled'

describe('playbookEnabled', () => {
  it('is on only for an explicit true', () => {
    expect(playbookEnabled({ enabled: { handoff: true } }, 'handoff')).toBe(true)
    expect(playbookEnabled({ enabled: { handoff: 'yes' } }, 'handoff')).toBe(false)
    expect(playbookEnabled({ enabled: { review: true } }, 'handoff')).toBe(false)
  })

  it('is off for anything that is not a settings record', () => {
    expect(playbookEnabled(undefined, 'handoff')).toBe(false)
    expect(playbookEnabled([], 'handoff')).toBe(false)
    expect(playbookEnabled({ enabled: [] }, 'handoff')).toBe(false)
  })
})
