import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?dataurl'
import geist from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?dataurl'
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?dataurl'

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

export const PANEL_FONT_FILES: Readonly<Record<string, string>> = {
  'Inter Variable': inter,
  'Geist Variable': geist,
  'Geist Mono Variable': geistMono,
}

export const PANEL_FALLBACK_FAMILIES = ['Inter Variable', 'Geist Mono Variable'] as const

export function panelFontFaces(families: readonly string[]): string {
  const wanted = new Set([...families, ...PANEL_FALLBACK_FAMILIES])
  return Object.entries(PANEL_FONT_FILES)
    .filter(([family]) => wanted.has(family))
    .map(
      ([family, url]) =>
        `@font-face { font-family: "${family}"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${url}") format("woff2-variations"); unicode-range: ${LATIN_RANGE}; }`,
    )
    .join('\n')
}
