import { describe, expect, it } from 'vitest'
import { TERMINAL_TITLE_MAX, terminalTitle } from './terminalTitle'

describe('terminalTitle', () => {
  it('keeps an agent’s task title as it set it', () => {
    expect(terminalTitle('✳ Review and merge PR #5500')).toBe('✳ Review and merge PR #5500')
  })

  it('drops control characters and surrounding space', () => {
    expect(terminalTitle('  build\x07 done\x1b ')).toBe('build done')
  })

  it('ignores a title that is empty once cleaned', () => {
    expect(terminalTitle(' \x07 ')).toBeNull()
  })

  it('caps a long title with an ellipsis', () => {
    const title = terminalTitle('x'.repeat(500)) as string
    expect(title).toHaveLength(TERMINAL_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
  })
})
