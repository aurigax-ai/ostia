import { wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { BUILTIN_COLOR_SCHEMES } from '../plugins/colorSchemes'
import type { ColorScheme } from '../plugins/types'
import {
  CODE_CONTRAST,
  COMMENT_CONTRAST,
  codeColors,
  monacoThemeData,
  monacoThemeId,
} from './monacoTheme'

const scheme = (id: string): ColorScheme =>
  BUILTIN_COLOR_SCHEMES.find((s) => s.id === id) as ColorScheme
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/
const BARE = /^[0-9a-f]{6}$/

describe('monacoThemeData', () => {
  it('paints the editor with the scheme background, foreground and cursor', () => {
    const mocha = scheme('catppuccin-mocha')
    const data = monacoThemeData(mocha)
    expect(data.base).toBe('vs-dark')
    expect(data.inherit).toBe(true)
    expect(data.colors['editor.background']).toBe(mocha.colors.background)
    expect(data.colors['editor.foreground']).toBe(mocha.colors.foreground)
    expect(data.colors['editorCursor.foreground']).toBe(mocha.colors.cursor)
  })

  it('bases light schemes on the vs theme', () => {
    expect(monacoThemeData(scheme('solarized-light')).base).toBe('vs')
    expect(monacoThemeData(scheme('pine-light')).base).toBe('vs')
  })

  it('maps syntax tokens onto the scheme ANSI colors', () => {
    const mocha = scheme('catppuccin-mocha')
    const rule = (token: string) => monacoThemeData(mocha).rules.find((r) => r.token === token)
    expect(rule('keyword')?.foreground).toBe(mocha.colors.magenta.slice(1))
    expect(rule('string')?.foreground).toBe(mocha.colors.green.slice(1))
    expect(rule('function')?.foreground).toBe(mocha.colors.blue.slice(1))
    expect(rule('type')?.foreground).toBe(mocha.colors.yellow.slice(1))
    expect(rule('comment')?.fontStyle).toBe('italic')
  })

  it('gives Monaco only valid color strings for every built-in scheme', () => {
    for (const s of BUILTIN_COLOR_SCHEMES) {
      const data = monacoThemeData(s)
      for (const [key, value] of Object.entries(data.colors)) {
        expect(value, `${s.id} ${key}`).toMatch(HEX)
      }
      for (const r of data.rules) expect(r.foreground, `${s.id} ${r.token}`).toMatch(BARE)
    }
  })

  it('keeps code readable on the editor background, lifting faint ANSI colors', () => {
    for (const s of BUILTIN_COLOR_SCHEMES) {
      const { comment, text: _text, ...code } = codeColors(s)
      const bg = s.colors.background
      for (const [token, color] of Object.entries(code)) {
        expect(wcagContrast(color, bg), `${s.id} ${token}`).toBeGreaterThanOrEqual(CODE_CONTRAST)
      }
      expect(wcagContrast(comment, bg), `${s.id} comment`).toBeGreaterThanOrEqual(COMMENT_CONTRAST)
    }
  })

  it('names each scheme theme distinctly', () => {
    const ids = BUILTIN_COLOR_SCHEMES.map(monacoThemeId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(monacoThemeId(scheme('nord'))).toBe('pine-scheme-nord')
  })
})
