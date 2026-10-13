import { describe, expect, it } from 'vitest'
import { parseChord } from './chordSpec'
import { DESKTOP_CHORDS, desktopTaking, desktopsOf } from './desktopChords'

const chord = (text: string) => {
  const spec = parseChord(text, false)
  if (!spec) throw new Error(`bad chord ${text}`)
  return spec
}

describe('desktopsOf', () => {
  it('splits XDG_CURRENT_DESKTOP on colons', () => {
    expect(desktopsOf('ubuntu:GNOME')).toEqual(['ubuntu', 'GNOME'])
    expect(desktopsOf('KDE')).toEqual(['KDE'])
  })

  it('finds no desktop when the variable is unset, empty or only colons', () => {
    expect(desktopsOf(undefined)).toEqual([])
    expect(desktopsOf('')).toEqual([])
    expect(desktopsOf(' : ')).toEqual([])
  })
})

describe('desktopTaking', () => {
  it('names the desktop that takes a chord, by any of its XDG names', () => {
    expect(desktopTaking(chord('Ctrl+Alt+Left'), ['ubuntu', 'GNOME'])).toBe('GNOME')
    expect(desktopTaking(chord('Super+L'), ['gnome'])).toBe('GNOME')
    expect(desktopTaking(chord('Ctrl+F2'), ['KDE'])).toBe('KDE Plasma')
  })

  it('matches one digit against a desktop’s digit range', () => {
    expect(desktopTaking(chord('Super+3'), ['GNOME'])).toBe('GNOME')
  })

  it('finds nothing for a free chord, an unknown desktop or no desktop', () => {
    expect(desktopTaking(chord('Ctrl+Shift+P'), ['GNOME', 'KDE'])).toBeNull()
    expect(desktopTaking(chord('Ctrl+F2'), ['GNOME'])).toBeNull()
    expect(desktopTaking(chord('Ctrl+Alt+Left'), ['XFCE'])).toBeNull()
    expect(desktopTaking(chord('Ctrl+Alt+Left'), ['constructor'])).toBeNull()
    expect(desktopTaking(chord('Ctrl+Alt+Left'), [])).toBeNull()
  })

  it('lists only chords that parse', () => {
    for (const keys of DESKTOP_CHORDS.values()) {
      for (const text of keys.chords) expect(parseChord(text, false), text).not.toBeNull()
    }
  })
})
