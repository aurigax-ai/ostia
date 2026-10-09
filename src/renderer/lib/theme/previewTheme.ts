import type { PreviewTheme } from '@shared/artifacts/htmlPreview'

const TOKENS: Readonly<Record<string, string>> = {
  '--ostia-bg': '--surface-1',
  '--ostia-surface': '--surface-2',
  '--ostia-fg': '--fg',
  '--ostia-muted': '--fg-muted',
  '--ostia-line': '--line',
  '--ostia-accent': '--brand',
  '--ostia-font': '--font-ui',
  '--ostia-font-mono': '--font-code',
}

export function previewTheme(root: HTMLElement = document.documentElement): PreviewTheme {
  const style = getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const [name, token] of Object.entries(TOKENS)) {
    const value = style.getPropertyValue(token).trim()
    if (value) vars[name] = value
  }
  return { dark: root.classList.contains('dark'), vars }
}
