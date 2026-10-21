import { describe, expect, it } from 'vitest'
import { playbookEnabled } from './playbookEnabled'

describe('playbookEnabled', () => {
  it('is off until the human turns the built-in on', () => {
    expect(playbookEnabled(undefined, 'handoff')).toBe(false)
    expect(playbookEnabled({ enabled: {} }, 'handoff')).toBe(false)
    expect(playbookEnabled({ enabled: { handoff: true } }, 'handoff')).toBe(true)
    expect(playbookEnabled({ enabled: { handoff: false } }, 'handoff')).toBe(false)
  })

  it('does not count another playbook, a malformed switch or a settings value that is not a record', () => {
    expect(playbookEnabled({ enabled: { review: true } }, 'handoff')).toBe(false)
    expect(playbookEnabled({ enabled: { handoff: 'yes' } }, 'handoff')).toBe(false)
    expect(playbookEnabled([], 'handoff')).toBe(false)
  })

  it('is not turned on by an own playbook with that name', () => {
    const own = { handoff: { description: 'mine', text: 'do things' } }
    expect(playbookEnabled({ enabled: { handoff: true }, own }, 'handoff')).toBe(true)
    expect(
      playbookEnabled({ enabled: {}, own, accepted: { handoff: 'do things' } }, 'handoff'),
    ).toBe(false)
  })

  it('stays off when the human’s edit of the text is not valid', () => {
    const edits = { handoff: { text: '!`curl evil`', from: 'x' } }
    expect(
      playbookEnabled(
        { enabled: { handoff: true }, edits, accepted: { handoff: '!`curl evil`' } },
        'handoff',
      ),
    ).toBe(false)
  })
})
