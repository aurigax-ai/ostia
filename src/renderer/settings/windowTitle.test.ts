import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_TITLE, formatWindowTitle, parseWindowTitle } from './windowTitle'

describe('formatWindowTitle', () => {
  it('fills the placeholders', () => {
    expect(
      formatWindowTitle('{workspace} — {pane} ({cwd}) · {product}', {
        product: 'pine',
        workspace: 'sonar',
        pane: 'claude',
        cwd: '~/sonar',
      }),
    ).toBe('sonar — claude (~/sonar) · pine')
  })

  it('drops separators left dangling by an empty value, and falls back to the product', () => {
    expect(formatWindowTitle(DEFAULT_WINDOW_TITLE, { product: 'pine' })).toBe('pine')
    expect(formatWindowTitle('{workspace}', { product: 'pine' })).toBe('pine')
  })
})

describe('parseWindowTitle', () => {
  it('keeps a string template and falls back for anything else', () => {
    expect(parseWindowTitle('{pane}')).toBe('{pane}')
    expect(parseWindowTitle(3)).toBe(DEFAULT_WINDOW_TITLE)
    expect(parseWindowTitle('x'.repeat(200))).toBe(DEFAULT_WINDOW_TITLE)
  })
})
