const TOKEN_NAME = /^[a-z0-9-]+$/
const UNSAFE_VALUE = /[;{}<>\\]/

export function panelThemeCss(
  tokens: Record<string, string>,
  fonts: { ui: string; mono: string },
  reducedMotion: boolean,
): string {
  const decls: string[] = []
  for (const [name, value] of Object.entries(tokens)) {
    if (TOKEN_NAME.test(name) && !UNSAFE_VALUE.test(value)) decls.push(`--pine-${name}: ${value};`)
  }
  if (!UNSAFE_VALUE.test(fonts.ui))
    decls.push(`--pine-font-ui: "${fonts.ui.replace(/"/g, '')}", system-ui, sans-serif;`)
  if (!UNSAFE_VALUE.test(fonts.mono)) {
    decls.push(`--pine-font-mono: "${fonts.mono.replace(/"/g, '')}", ui-monospace, monospace;`)
  }
  decls.push(`--pine-motion-scale: ${reducedMotion ? 0 : 1};`)
  return `:root { ${decls.join(' ')} }`
}
