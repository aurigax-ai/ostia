import type { editor } from 'monaco-editor'
import { ensureContrast, mix, normalizeHex } from '../lib/color'
import type { ColorScheme } from '../plugins/types'

export const CODE_CONTRAST = 4.5
export const COMMENT_CONTRAST = 3

const RGBA = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/

function solid(color: string, background: string): string {
  const hex = normalizeHex(color)
  if (hex) return hex
  const m = RGBA.exec(color.trim())
  if (!m) return background
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0'))
  return mix(background, `#${r}${g}${b}`, m[4] === undefined ? 1 : Number(m[4]))
}

const bare = (hex: string): string => hex.slice(1)

export interface CodeColors {
  text: string
  comment: string
  keyword: string
  operator: string
  delimiter: string
  string: string
  number: string
  type: string
  function: string
  variable: string
}

export function codeColors(scheme: ColorScheme): CodeColors {
  const c = scheme.colors
  const bg = c.background
  const readable = (color: string): string => ensureContrast(color, bg, CODE_CONTRAST)
  return {
    text: c.foreground,
    comment: ensureContrast(c.brightBlack, bg, COMMENT_CONTRAST),
    keyword: readable(c.magenta),
    operator: readable(c.cyan),
    delimiter: readable(mix(c.foreground, bg, 0.25)),
    string: readable(c.green),
    number: readable(mix(c.red, c.yellow, 0.5)),
    type: readable(c.yellow),
    function: readable(c.blue),
    variable: readable(c.red),
  }
}

export const monacoThemeId = (scheme: ColorScheme): string => `pine-scheme-${scheme.id}`

function selectionColor(scheme: ColorScheme): string {
  const { background, selectionBackground, selectionForeground } = scheme.colors
  const base = solid(selectionBackground, background)
  return selectionForeground ? mix(background, base, 0.45) : base
}

export function monacoThemeData(scheme: ColorScheme): editor.IStandaloneThemeData {
  const c = scheme.colors
  const bg = c.background
  const code = codeColors(scheme)
  const dark = scheme.appearance === 'dark'
  const toward = (amount: number): string => mix(bg, c.foreground, amount)
  const widget = dark ? mix(bg, '#000000', 0.2) : mix(bg, '#ffffff', 0.6)
  const selection = selectionColor(scheme)
  const rule = (token: string, color: string, fontStyle?: string) =>
    fontStyle ? { token, foreground: bare(color), fontStyle } : { token, foreground: bare(color) }
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      rule('', code.text),
      rule('comment', code.comment, 'italic'),
      rule('keyword', code.keyword),
      rule('keyword.flow', code.keyword),
      rule('operator', code.operator),
      rule('delimiter', code.delimiter),
      rule('string', code.string),
      rule('string.escape', code.operator),
      rule('string.key.json', code.variable),
      rule('number', code.number),
      rule('regexp', code.string),
      rule('type', code.type),
      rule('type.identifier', code.type),
      rule('identifier', code.variable),
      rule('function', code.function),
      rule('variable', code.variable),
      rule('variable.predefined', code.number),
      rule('constant', code.number),
      rule('tag', code.variable),
      rule('attribute.name', code.number),
      rule('attribute.value', code.string),
    ],
    colors: {
      'editor.background': bg,
      'editor.foreground': c.foreground,
      'editorCursor.foreground': solid(c.cursor, bg),
      'editor.lineHighlightBackground': toward(0.06),
      'editorLineNumber.foreground': ensureContrast(toward(0.4), bg, COMMENT_CONTRAST),
      'editorLineNumber.activeForeground': toward(0.8),
      'editor.selectionBackground': `${selection}cc`,
      'editor.inactiveSelectionBackground': `${selection}77`,
      'editorIndentGuide.background1': toward(0.12),
      'editorIndentGuide.activeBackground1': toward(0.3),
      'editorWidget.background': widget,
      'editorWidget.border': toward(0.15),
      'editorSuggestWidget.background': widget,
      'editorSuggestWidget.selectedBackground': toward(0.14),
      'editorGutter.background': bg,
      'editorWhitespace.foreground': toward(0.18),
      'scrollbarSlider.background': `${c.foreground}22`,
      'scrollbarSlider.hoverBackground': `${c.foreground}44`,
    },
  }
}
