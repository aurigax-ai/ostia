import { wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { mix } from '../lib/color'
import { BUILTIN_COLOR_SCHEMES } from '../plugins/colorSchemes'
import type { ColorScheme } from '../plugins/types'
import {
  CODE_CONTRAST,
  COMMENT_CONTRAST,
  DIFF_CONTRAST_KEEP,
  DIFF_LINE_ALPHA,
  DIFF_MIN_STRENGTH,
  DIFF_TOKEN_CONTRAST,
  codeColors,
  diffColors,
  diffTintStrength,
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

const alphaOf = (hex: string): number => Number.parseInt(hex.slice(7, 9), 16) / 255

describe('diffColors', () => {
  it('tints added and removed lines with the scheme green and red, not fixed hues', () => {
    const mocha = scheme('catppuccin-mocha')
    const light = scheme('pine-light')
    const dark = diffColors(mocha)
    expect(dark.inserted).toBe(mocha.colors.green)
    expect(dark.removed).toBe(mocha.colors.red)
    expect(dark.insertedLine.slice(0, 7)).toBe(mocha.colors.green)
    expect(dark.removedText.slice(0, 7)).toBe(mocha.colors.red)
    expect(diffColors(light).inserted).toBe(light.colors.green)
    const colors = monacoThemeData(mocha).colors
    expect(colors['diffEditor.insertedLineBackground']).toBe(dark.insertedLine)
    expect(colors['diffEditor.removedLineBackground']).toBe(dark.removedLine)
    expect(colors['diffEditor.insertedTextBackground']).toBe(dark.insertedText)
    expect(colors['diffEditor.removedTextBackground']).toBe(dark.removedText)
  })

  it('keeps line tints faint and changed characters a step stronger', () => {
    for (const s of BUILTIN_COLOR_SCHEMES) {
      const d = diffColors(s)
      for (const [line, text] of [
        [d.insertedLine, d.insertedText],
        [d.removedLine, d.removedText],
      ]) {
        expect(alphaOf(line), s.id).toBeLessThanOrEqual(DIFF_LINE_ALPHA + 0.01)
        expect(alphaOf(line), s.id).toBeGreaterThan(0)
        expect(alphaOf(text), s.id).toBeGreaterThan(alphaOf(line))
      }
    }
  })

  it('keeps text readable on a changed character inside a changed line, in every scheme', () => {
    for (const s of BUILTIN_COLOR_SCHEMES) {
      const d = diffColors(s)
      const bg = s.colors.background
      const { comment: _comment, text, ...tokens } = codeColors(s)
      for (const [tint, line, chars] of [
        [d.inserted, d.insertedLine, d.insertedText],
        [d.removed, d.removedLine, d.removedText],
      ]) {
        const changed = mix(mix(bg, tint, alphaOf(line)), tint, alphaOf(chars))
        const floor = (color: string, target: number): number =>
          Math.min(target, wcagContrast(color, bg) * DIFF_CONTRAST_KEEP) - 0.05
        if (diffTintStrength(s, tint) > DIFF_MIN_STRENGTH) {
          expect(wcagContrast(text, changed), `${s.id} text`).toBeGreaterThanOrEqual(
            floor(text, CODE_CONTRAST),
          )
          for (const [token, color] of Object.entries(tokens)) {
            expect(wcagContrast(color, changed), `${s.id} ${token}`).toBeGreaterThanOrEqual(
              floor(color, DIFF_TOKEN_CONTRAST),
            )
          }
        }
        expect(wcagContrast(text, changed), `${s.id} text`).toBeGreaterThanOrEqual(
          Math.min(CODE_CONTRAST, wcagContrast(text, bg)) * 0.85,
        )
      }
    }
  })

  it('takes the change hues from the slot that holds them in a scheme with remapped ANSI colors', () => {
    const oxocarbon = scheme('oxocarbon')
    const d = diffColors(oxocarbon)
    expect(d.removed).toBe(oxocarbon.colors.yellow)
    expect(d.inserted).toBe(oxocarbon.colors.blue)
    for (const s of BUILTIN_COLOR_SCHEMES.filter((x) => x.id !== 'oxocarbon')) {
      expect(diffColors(s).removed, s.id).toBe(s.colors.red)
      expect(diffColors(s).inserted, s.id).toBe(s.colors.green)
    }
  })

  it('backs off the tint on a scheme whose code color matches the change hue', () => {
    const dracula = scheme('dracula')
    const mocha = scheme('catppuccin-mocha')
    expect(diffTintStrength(dracula, dracula.colors.green)).toBeLessThan(1)
    expect(diffTintStrength(mocha, mocha.colors.green)).toBe(1)
  })
})
