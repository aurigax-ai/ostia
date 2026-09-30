import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../lib/color'
import { terminalPalette } from './terminalTheme'

describe('terminalPalette', () => {
  it('returns the Adeberry palette for the "adeberry" theme id, with the signature cyan accent', () => {
    const palette = terminalPalette('adeberry')
    expect(palette.background).toBe('#1d2022')
    expect(palette.foreground).toBe('#d5dde3')
    expect(palette.cursor).toBe('#00d8ff')
    expect(palette.brightBlue).toBe(palette.cyan)
    expect(palette.brightBlue).toBe('#5aceca')
  })

  it('returns the One Dark Vivid palette for the "one-dark-vivid" theme id', () => {
    const palette = terminalPalette('one-dark-vivid')
    expect(palette.background).toBe('#282c34')
    expect(palette.cursor).toBe('#61afef')
  })

  it('falls back to the One Dark Vivid palette for a theme with no dedicated xterm palette', () => {
    expect(terminalPalette('instrument-night')).toEqual(terminalPalette('one-dark-vivid'))
    expect(terminalPalette('dracula')).toEqual(terminalPalette('one-dark-vivid'))
  })

  it('falls back to the One Dark Vivid palette for a completely unknown theme id', () => {
    expect(terminalPalette('no-such-theme')).toEqual(terminalPalette('one-dark-vivid'))
  })

  it('gives pine-light a light palette whose text colors all read at 4.5:1 on its background', () => {
    const palette = terminalPalette('pine-light')
    const background = palette.background as string
    expect(background).not.toBe(terminalPalette('one-dark-vivid').background)
    for (const [name, color] of Object.entries(palette)) {
      if (['background', 'cursorAccent', 'selectionBackground'].includes(name)) continue
      expect(contrastRatio(color as string, background), name).toBeGreaterThanOrEqual(4.5)
    }
  })
})
