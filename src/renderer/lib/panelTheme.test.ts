import { describe, expect, it } from 'vitest'
import { panelThemeCss } from './panelTheme'

describe('panelThemeCss', () => {
  it('exposes theme tokens and fonts to panels as --pine-* custom properties', () => {
    const css = panelThemeCss(
      { bg: '#1d2022', 'fg-muted': 'rgba(255, 255, 255, 0.5)' },
      { ui: 'Inter', mono: 'Geist Mono' },
      'dark',
      false,
    )
    expect(css).toBe(
      ':root { --pine-color-scheme: dark; --pine-bg: #1d2022; --pine-fg-muted: rgba(255, 255, 255, 0.5); ' +
        '--pine-font-ui: "Inter", system-ui, sans-serif; ' +
        '--pine-font-mono: "Geist Mono", ui-monospace, monospace; --pine-motion-scale: 1; }',
    )
  })

  it('tells panels whether the theme is light or dark', () => {
    expect(panelThemeCss({}, { ui: 'Inter', mono: 'Mono' }, 'light', false)).toContain(
      '--pine-color-scheme: light;',
    )
  })

  it('drops values that could break out of the declaration block', () => {
    const css = panelThemeCss(
      { bg: 'red; } body { display: none', 'Bad Name': '#fff', ok: '#0f0' },
      { ui: 'Inter"; } *{', mono: 'Mono' },
      'dark',
      false,
    )
    expect(css).not.toContain('display')
    expect(css).not.toContain('Bad Name')
    expect(css).not.toContain('--pine-font-ui')
    expect(css).toContain('--pine-ok: #0f0;')
  })

  it('scales panel motion to zero while motion is reduced and back to one after', () => {
    const fonts = { ui: 'Inter', mono: 'Mono' }
    expect(panelThemeCss({}, fonts, 'dark', true)).toContain('--pine-motion-scale: 0;')
    expect(panelThemeCss({}, fonts, 'dark', false)).toContain('--pine-motion-scale: 1;')
  })
})
