import { codeFontStack, uiFontStack } from './uiFonts'

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
  const decls: string[] = [`--pine-color-scheme: ${appearance};`]
  for (const [name, value] of Object.entries(tokens)) {
    if (TOKEN_NAME.test(name) && !UNSAFE_VALUE.test(value)) decls.push(`--pine-${name}: ${value};`)
  }
  if (!UNSAFE_VALUE.test(fonts.ui)) decls.push(`--pine-font-ui: ${uiFontStack(fonts.ui)};`)
  if (!UNSAFE_VALUE.test(fonts.code)) decls.push(`--pine-font-code: ${codeFontStack(fonts.code)};`)
  if (Number.isFinite(fonts.size)) decls.push(`--pine-font-size: ${Math.round(fonts.size)}px;`)
  if (Number.isFinite(fonts.weight)) decls.push(`--pine-font-weight: ${Math.round(fonts.weight)};`)
  decls.push(`--pine-motion-scale: ${reducedMotion ? 0 : 1};`)
  return `:root { ${decls.join(' ')} }`
}
