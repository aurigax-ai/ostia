import { describe, expect, it } from 'vitest'
import { panelFontFaces } from './panelFontFaces'
import { panelThemeCss } from './panelTheme'
import { CODE_FONT_FALLBACK, UI_FONT_FALLBACK } from './uiFonts'

const fonts = { ui: 'Inter', code: 'Mono', size: 13, weight: 400 }

describe('panelThemeCss', () => {
  it('exposes theme tokens and the human font settings to panels as --pine-* properties', () => {
    const css = panelThemeCss(
      { bg: '#1d2022', 'fg-muted': 'rgba(255, 255, 255, 0.5)' },
      { ui: 'Inter', code: 'Geist Mono', size: 14, weight: 450 },
      'dark',
      false,
    )
    expect(css).toBe(
      `:root { --pine-color-scheme: dark; --pine-bg: #1d2022; --pine-fg-muted: rgba(255, 255, 255, 0.5); --pine-font-ui: "Inter", ${UI_FONT_FALLBACK}; --pine-font-code: "Geist Mono", ${CODE_FONT_FALLBACK}; --pine-font-size: 14px; --pine-font-weight: 450; --pine-motion-scale: 1; }`,
    )
  })

  it('tells panels whether the theme is light or dark', () => {
    expect(panelThemeCss({}, fonts, 'light', false)).toContain('--pine-color-scheme: light;')
  })

  it('drops values that could break out of the declaration block', () => {
    const css = panelThemeCss(
      { bg: 'red; } body { display: none', 'Bad Name': '#fff', ok: '#0f0' },
      { ...fonts, ui: 'Inter"; } *{' },
      'dark',
      false,
    )
    expect(css).not.toContain('display')
    expect(css).not.toContain('Bad Name')
    expect(css).not.toContain('--pine-font-ui')
    expect(css).toContain('--pine-ok: #0f0;')
  })

  it('scales panel motion to zero while motion is reduced and back to one after', () => {
    expect(panelThemeCss({}, fonts, 'dark', true)).toContain('--pine-motion-scale: 0;')
    expect(panelThemeCss({}, fonts, 'dark', false)).toContain('--pine-motion-scale: 1;')
  })
})

describe('panelFontFaces', () => {
  it('embeds the bundled fallback faces so a panel never drops to a system font', () => {
    const css = panelFontFaces(['DejaVu Sans', 'Fira Code'])
    expect(css).toContain('font-family: "Inter Variable"')
    expect(css).toContain('font-family: "Geist Mono Variable"')
    expect(css).not.toContain('"Geist Variable"')
    expect(css).toMatch(/src: url\("data:font\/woff2;base64,/)
  })

  it('embeds a chosen bundled family too', () => {
    expect(panelFontFaces(['Geist Variable'])).toContain('font-family: "Geist Variable"')
  })
})
