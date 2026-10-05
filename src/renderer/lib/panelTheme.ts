import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from '@shared/product'
import { codeFontStack, uiFontStack } from './uiFonts'

export const PANEL_VAR_PREFIXES = [PRODUCT_NAME, LEGACY_PRODUCT_NAME]

const TOKEN_NAME = /^[a-z0-9-]+$/
const UNSAFE_VALUE = /[;{}<>\\"]/

export interface PanelFonts {
  ui: string
  code: string
  size: number
  weight: number
}

export function panelThemeCss(
  tokens: Record<string, string>,
  fonts: PanelFonts,
  appearance: 'dark' | 'light',
  reducedMotion: boolean,
): string {
  const vars: [string, string][] = [['color-scheme', appearance]]
  for (const [name, value] of Object.entries(tokens)) {
    if (TOKEN_NAME.test(name) && !UNSAFE_VALUE.test(value)) vars.push([name, value])
  }
  if (!UNSAFE_VALUE.test(fonts.ui)) vars.push(['font-ui', uiFontStack(fonts.ui)])
  if (!UNSAFE_VALUE.test(fonts.code)) vars.push(['font-code', codeFontStack(fonts.code)])
  if (Number.isFinite(fonts.size)) vars.push(['font-size', `${Math.round(fonts.size)}px`])
  if (Number.isFinite(fonts.weight)) vars.push(['font-weight', `${Math.round(fonts.weight)}`])
  vars.push(['motion-scale', reducedMotion ? '0' : '1'])
  const decls = PANEL_VAR_PREFIXES.flatMap((prefix) =>
    vars.map(([name, value]) => `--${prefix}-${name}: ${value};`),
  )
  return `:root { ${decls.join(' ')} }`
}
