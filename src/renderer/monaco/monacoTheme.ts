import { ensureContrast, mix } from '@/lib/theme/color'
import { converter, formatHex, modeOklch, parse, useMode, wcagContrast } from 'culori/fn'
import type { editor } from 'monaco-editor'
import type { ColorScheme } from '../plugins/types'

useMode(modeOklch)
const toOklch = converter('oklch')

export const CODE_CONTRAST = 4.5
export const COMMENT_CONTRAST = 3

function solid(color: string, background: string): string {
  const parsed = parse(color.trim())
  if (!parsed) return background
  return mix(background, formatHex(parsed), parsed.alpha ?? 1)
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

export const monacoThemeId = (scheme: ColorScheme): string => `ostia-scheme-${scheme.id}`

export const DIFF_LINE_ALPHA = 0.1
export const DIFF_TEXT_ALPHA = 0.18
export const DIFF_MARK_ALPHA = 0.7
export const DIFF_TOKEN_CONTRAST = 3
export const DIFF_CONTRAST_KEEP = 0.9
export const DIFF_MIN_STRENGTH = 0.25
export const REMOVED_HUE = 25
export const INSERTED_HUE = 145
const HUE_TOLERANCE = 45
const MIN_CHROMA = 0.06

export interface DiffColors {
  inserted: string
  removed: string
  insertedLine: string
  removedLine: string
  insertedText: string
  removedText: string
  insertedMark: string
  removedMark: string
}

const withAlpha = (hex: string, alpha: number): string =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`

function keepsContrast(color: string, changed: string, bg: string, target: number): boolean {
  return (
    wcagContrast(color, changed) >= Math.min(target, wcagContrast(color, bg) * DIFF_CONTRAST_KEEP)
  )
}

export function diffTintStrength(scheme: ColorScheme, tint: string): number {
  const bg = scheme.colors.background
  const { comment: _comment, text, ...tokens } = codeColors(scheme)
  for (let step = 0; 1 - step / 20 > DIFF_MIN_STRENGTH; step++) {
    const strength = 1 - step / 20
    const line = mix(bg, tint, DIFF_LINE_ALPHA * strength)
    const changed = mix(line, tint, DIFF_TEXT_ALPHA * strength)
    const readable =
      keepsContrast(text, changed, bg, CODE_CONTRAST) &&
      Object.values(tokens).every((color) => keepsContrast(color, changed, bg, DIFF_TOKEN_CONTRAST))
    if (readable) return strength
  }
  return DIFF_MIN_STRENGTH
}

function hueDistance(color: string, hue: number): number {
  const lch = toOklch(color)
  if (!lch || (lch.c ?? 0) < MIN_CHROMA) return Number.POSITIVE_INFINITY
  const d = Math.abs((lch.h ?? 0) - hue) % 360
  return d > 180 ? 360 - d : d
}

export function changeHue(scheme: ColorScheme, slot: 'red' | 'green', hue: number): string {
  const c = scheme.colors
  if (hueDistance(c[slot], hue) <= HUE_TOLERANCE) return c[slot]
  const ansi = [c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan]
  const bright = [c.brightRed, c.brightGreen, c.brightYellow, c.brightBlue, c.brightMagenta]
  const nearest = [...ansi, ...bright, c.brightCyan].reduce((best, color) =>
    hueDistance(color, hue) < hueDistance(best, hue) ? color : best,
  )
  return hueDistance(nearest, hue) <= HUE_TOLERANCE ? nearest : c[slot]
}

export function diffColors(scheme: ColorScheme): DiffColors {
  const tinted = (color: string) => {
    const hex = solid(color, scheme.colors.background)
    const strength = diffTintStrength(scheme, hex)
    return {
      base: hex,
      line: withAlpha(hex, DIFF_LINE_ALPHA * strength),
      text: withAlpha(hex, DIFF_TEXT_ALPHA * strength),
      mark: withAlpha(hex, DIFF_MARK_ALPHA),
    }
  }
  const inserted = tinted(changeHue(scheme, 'green', INSERTED_HUE))
  const removed = tinted(changeHue(scheme, 'red', REMOVED_HUE))
  return {
    inserted: inserted.base,
    removed: removed.base,
    insertedLine: inserted.line,
    removedLine: removed.line,
    insertedText: inserted.text,
    removedText: removed.text,
    insertedMark: inserted.mark,
    removedMark: removed.mark,
  }
}

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
  const diff = diffColors(scheme)
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
      rule('namespace', code.type),
      rule('class', code.type),
      rule('enum', code.type),
      rule('interface', code.type),
      rule('struct', code.type),
      rule('typeParameter', code.type),
      rule('method', code.function),
      rule('macro', code.function),
      rule('decorator', code.function),
      rule('modifier', code.keyword),
      rule('parameter', code.variable),
      rule('property', code.variable),
      rule('enumMember', code.number),
      rule('event', code.variable),
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
      'diffEditor.insertedLineBackground': diff.insertedLine,
      'diffEditor.removedLineBackground': diff.removedLine,
      'diffEditor.insertedTextBackground': diff.insertedText,
      'diffEditor.removedTextBackground': diff.removedText,
      'diffEditorGutter.insertedLineBackground': diff.insertedLine,
      'diffEditorGutter.removedLineBackground': diff.removedLine,
      'diffEditorOverview.insertedForeground': diff.insertedMark,
      'diffEditorOverview.removedForeground': diff.removedMark,
      'diffEditor.diagonalFill': toward(0.12),
      'scrollbarSlider.background': `${c.foreground}22`,
      'scrollbarSlider.hoverBackground': `${c.foreground}44`,
    },
  }
}
