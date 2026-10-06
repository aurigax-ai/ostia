import { describe, expect, it } from 'vitest'
import { paletteMode } from './paletteModes'

describe('paletteMode', () => {
  it('reads the mode from the leading symbol', () => {
    expect(paletteMode('?')).toBe('help')
    expect(paletteMode('>split')).toBe('commands')
    expect(paletteMode('@pay')).toBe('workspaces')
    expect(paletteMode('  #zsh')).toBe('tabs')
    expect(paletteMode('/main')).toBe('files')
    expect(paletteMode('%greet')).toBe('symbols')
  })

  it('searches everything without a prefix', () => {
    expect(paletteMode('')).toBe('all')
    expect(paletteMode('split @ right')).toBe('all')
  })
})
