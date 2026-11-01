import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('./image.html', import.meta.url), 'utf8')
const phosphor = readFileSync(
  new URL(
    '../../../node_modules/@phosphor-icons/core/assets/fill/navigation-arrow-fill.svg',
    import.meta.url,
  ),
  'utf8',
)

function cursorSvg(name: 'dark' | 'light', density: '1x' | '2x'): string {
  const value = html.match(new RegExp(`--image-cursor-${name}: ([^;]+);`))?.[1] ?? ''
  const uri = value.match(new RegExp(`url\\("data:image/svg\\+xml,([^"]+)"\\) ${density}`))?.[1]
  return decodeURIComponent(uri ?? '')
}

describe('image canvas cursor', () => {
  it('draws the Phosphor NavigationArrow fill path', () => {
    const path = phosphor.match(/ d="([^"]+)"/)?.[1]
    for (const name of ['dark', 'light'] as const) {
      expect(cursorSvg(name, '1x')).toContain(`d="${path}"`)
    }
  })

  it('is a white arrow with a dark edge on a dark theme', () => {
    const svg = cursorSvg('dark', '1x')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('stroke="#1a1a1a"')
  })

  it('is a dark arrow with a light edge on a light theme', () => {
    const svg = cursorSvg('light', '1x')
    expect(svg).toContain('fill="#1a1a1a"')
    expect(svg).toContain('stroke="#ffffff"')
  })

  it('is 24px at 1x and 48px at 2x, hotspot on the tip, with the system arrow as fallback', () => {
    expect(cursorSvg('dark', '1x')).toContain('width="24" height="24"')
    expect(cursorSvg('dark', '2x')).toContain('width="48" height="48"')
    for (const name of ['dark', 'light']) {
      const value = html.match(new RegExp(`--image-cursor-${name}: ([^;]+);`))?.[1] ?? ''
      expect(value).toMatch(/^image-set\(.+\) 5 5, default$/)
    }
  })

  it('follows the theme the host injects', () => {
    expect(html).toMatch(/\.canvas \{[^}]*cursor: var\(--image-cursor-dark\);/)
    expect(html).toMatch(
      /@container style\(--ostia-color-scheme: light\) \{\s*\.canvas \{\s*cursor: var\(--image-cursor-light\);/,
    )
  })

  it('keeps the grab cursors for panning', () => {
    expect(html).toMatch(/data-pan="ready"\] \{\s*cursor: grab;/)
    expect(html).toMatch(/data-pan="active"\] \{\s*cursor: grabbing;/)
    expect(html).toMatch(/\.stage\[data-pan\] \.canvas \{\s*cursor: inherit;/)
  })
})
