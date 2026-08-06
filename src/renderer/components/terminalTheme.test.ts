import { describe, expect, it } from 'vitest'
import { terminalPalette } from './terminalTheme'

/**
 * `terminalPalette` maps an app theme id (`settingsStore.appearance.theme`) to xterm's ANSI
 * `ITheme` — xterm renders to canvas, so it can't read the `--color-*` CSS custom properties
 * the rest of the UI re-themes with; each app theme needs its own hex/rgba palette here.
 */
describe('terminalPalette', () => {
  it('returns the Adeberry palette for the "adeberry" theme id, with the signature cyan accent', () => {
    const palette = terminalPalette('adeberry')
    expect(palette.background).toBe('#1d2022')
    expect(palette.foreground).toBe('#d5dde3')
    expect(palette.cursor).toBe('#00d8ff')
    // Adeberry's bright blue is intentionally teal, not a lightened blue — same value as cyan.
    expect(palette.brightBlue).toBe(palette.cyan)
    expect(palette.brightBlue).toBe('#5aceca')
  })

  it('returns the One Dark Vivid palette for the "one-dark-vivid" theme id', () => {
    const palette = terminalPalette('one-dark-vivid')
    expect(palette.background).toBe('#282c34')
    expect(palette.cursor).toBe('#61afef')
  })

  it('falls back to the One Dark Vivid palette for a theme with no dedicated xterm palette', () => {
    // Instrument Night / Dracula / Oxocarbon are real app themes (plugins/builtin.ts) but don't
    // have a bespoke terminal palette yet — degrade gracefully rather than an undefined theme.
    expect(terminalPalette('instrument-night')).toEqual(terminalPalette('one-dark-vivid'))
    expect(terminalPalette('dracula')).toEqual(terminalPalette('one-dark-vivid'))
  })

  it('falls back to the One Dark Vivid palette for a completely unknown theme id', () => {
    expect(terminalPalette('no-such-theme')).toEqual(terminalPalette('one-dark-vivid'))
  })
})
