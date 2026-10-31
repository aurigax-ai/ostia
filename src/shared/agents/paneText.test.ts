import { describe, expect, it } from 'vitest'
import { otherPaneText, PANE_TEXT_MAX } from './paneText'

describe('otherPaneText', () => {
  it('says another agent or program wrote it, names the pane and wraps the text', () => {
    const wrapped = otherPaneText('abcdef12-3456-7890', 'hello')
    expect(wrapped).toContain('abcdef12')
    expect(wrapped).toContain('not the human')
    expect(wrapped).toContain('<ostia-pane-output>\nhello\n</ostia-pane-output>')
  })

  it('strips control characters and cannot name a pane with markup', () => {
    const wrapped = otherPaneText('a"><x', 'ok\u001b[31m red')
    expect(wrapped).not.toContain('\u001b')
    expect(wrapped).not.toContain('"><x')
  })

  it('keeps the end of a text over the cap and says so', () => {
    const wrapped = otherPaneText('p', `${'a'.repeat(PANE_TEXT_MAX)}END`)
    expect(wrapped).toContain('(earlier output not shown)')
    expect(wrapped).toContain('END\n</ostia-pane-output>')
    expect(wrapped.length).toBeLessThan(PANE_TEXT_MAX + 500)
  })
})
