import { describe, expect, it } from 'vitest'
import { panelThemeCss } from './panelTheme'

describe('panelThemeCss', () => {
  it('exposes theme tokens and fonts to panels as --pine-* custom properties', () => {
    const css = panelThemeCss(
      { bg: '#1d2022', 'fg-muted': 'rgba(255, 255, 255, 0.5)' },
      { ui: 'Inter', mono: 'Geist Mono' },
      'dark',
    )
    expect(css).toBe(
      ':root { --pine-color-scheme: dark; --pine-bg: #1d2022; --pine-fg-muted: rgba(255, 255, 255, 0.5); ' +
        '--pine-font-ui: "Inter", system-ui, sans-serif; ' +
        '--pine-font-mono: "Geist Mono", ui-monospace, monospace; }',
    )
  })

  it('tells panels whether the theme is light or dark', () => {
    expect(panelThemeCss({}, { ui: 'Inter', mono: 'Mono' }, 'light')).toContain(
      '--pine-color-scheme: light;',
    )
  })

  it('drops values that could break out of the declaration block', () => {
    const css = panelThemeCss(
      { bg: 'red; } body { display: none', 'Bad Name': '#fff', ok: '#0f0' },
      { ui: 'Inter"; } *{', mono: 'Mono' },
      'dark',
    )
    expect(css).not.toContain('display')
    expect(css).not.toContain('Bad Name')
    expect(css).not.toContain('--pine-font-ui')
    expect(css).toContain('--pine-ok: #0f0;')
  })
})
