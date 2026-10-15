import { isMac } from '@/platform'
import type { SurfaceFont } from '@/stores/app/settingsModel'

export const UI_FONT_FALLBACK =
  '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, "PingFang TC", "Microsoft JhengHei", "Hiragino Sans", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'

const LATIN_MONO_FALLBACK = '"DejaVu Sans Mono", SFMono-Regular, Menlo, Consolas'

const cjkMonoFallback = (mac: boolean): string =>
  `"Sarasa Mono TC", "Noto Sans Mono CJK TC", ${mac ? '"PingFang TC", ' : ''}monospace`

export const codeFontFallback = (mac: boolean): string =>
  `"Geist Mono Variable", "Hack Nerd Font Mono", ${LATIN_MONO_FALLBACK}, ${cjkMonoFallback(mac)}`

export const terminalFontFallback = (mac: boolean): string =>
  `"Hack Nerd Font Mono", ${LATIN_MONO_FALLBACK}, ${cjkMonoFallback(mac)}`

export const CODE_FONT_FALLBACK = codeFontFallback(isMac)

export const TERMINAL_FONT_FALLBACK = terminalFontFallback(isMac)

const UNSAFE_IN_FAMILY = /["\\;{}<>]/g

export function fontStack(family: string, fallback: string): string {
  const name = family.replace(UNSAFE_IN_FAMILY, '').trim()
  return name ? `"${name}", ${fallback}` : fallback
}

export const terminalFontStack = (family: string): string =>
  fontStack(family, TERMINAL_FONT_FALLBACK)

export const codeFontStack = (family: string): string => fontStack(family, CODE_FONT_FALLBACK)

export const uiFontStack = (family: string): string => fontStack(family, UI_FONT_FALLBACK)

export function preloadFonts(fonts: {
  ui: SurfaceFont
  terminal: SurfaceFont
  editor: SurfaceFont
}): Promise<unknown> {
  if (!document.fonts) return Promise.resolve()
  const faces = [
    `${fonts.ui.weight} ${fonts.ui.size}px ${uiFontStack(fonts.ui.family)}`,
    `${fonts.terminal.weight} ${fonts.terminal.size}px ${terminalFontStack(fonts.terminal.family)}`,
    `bold ${fonts.terminal.size}px ${terminalFontStack(fonts.terminal.family)}`,
    `${fonts.editor.weight} ${fonts.editor.size}px ${codeFontStack(fonts.editor.family)}`,
  ]
  return Promise.allSettled(faces.map((face) => document.fonts.load(face)))
}

export interface UiFontSettings {
  ui: SurfaceFont
  editor: SurfaceFont
}

export function uiFontVariables({ ui, editor }: UiFontSettings): Record<string, string> {
  return {
    '--font-ui': uiFontStack(ui.family),
    '--font-code': codeFontStack(editor.family),
    '--font-ui-size': `${ui.size}px`,
    '--font-ui-weight': String(ui.weight),
  }
}

export function applyUiFonts(root: HTMLElement, fonts: UiFontSettings): void {
  for (const [name, value] of Object.entries(uiFontVariables(fonts))) {
    root.style.setProperty(name, value)
  }
}
