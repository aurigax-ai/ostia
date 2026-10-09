import { useSettingsStore } from '@/stores/app/settingsStore'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_FONT_FALLBACK,
  TERMINAL_FONT_FALLBACK,
  UI_FONT_FALLBACK,
  applyUiFonts,
  fontStack,
  preloadFonts,
  uiFontVariables,
} from './uiFonts'

const fonts = {
  ui: { family: 'Inter Variable', size: 14, weight: 500 },
  editor: { family: 'Bitstream Vera Sans Mono', size: 14, weight: 500 },
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
})

describe('uiFontVariables', () => {
  it('turns the UI and editor settings into the UI and code font tokens', () => {
    expect(uiFontVariables(fonts)).toEqual({
      '--font-ui': `"Inter Variable", ${UI_FONT_FALLBACK}`,
      '--font-code': `"Bitstream Vera Sans Mono", ${CODE_FONT_FALLBACK}`,
      '--font-ui-size': '14px',
      '--font-ui-weight': '500',
    })
  })

  it('writes the tokens on the root element', () => {
    applyUiFonts(document.documentElement, fonts)
    const style = document.documentElement.style
    expect(style.getPropertyValue('--font-code')).toContain('"Bitstream Vera Sans Mono"')
    expect(style.getPropertyValue('--font-ui-size')).toBe('14px')
  })

  it('the UI, settings lists, keycaps, chat code and the git panel use the chosen UI and code fonts', async () => {
    const ui = { family: 'Geist Variable', size: 14, weight: 400 }
    const editor = { family: 'Geist Mono Variable', size: 13, weight: 400 }
    const terminal = { family: 'Hack Nerd Font Mono', size: 13, weight: 400 }
    const load = vi.fn(async (_face: string) => [])
    Object.defineProperty(document, 'fonts', { value: { load }, configurable: true })
    try {
      await preloadFonts({ ui, terminal, editor })
    } finally {
      Reflect.deleteProperty(document, 'fonts')
    }
    applyUiFonts(document.documentElement, { ui, editor })

    const style = document.documentElement.style
    expect(style.getPropertyValue('--font-ui')).toMatch(/^"Geist Variable", /)
    expect(style.getPropertyValue('--font-code')).toMatch(/^"Geist Mono Variable", /)
    expect(style.getPropertyValue('--font-ui-size')).toBe('14px')
    const faces = load.mock.calls.map(([face]) => face)
    expect(faces.some((face) => face.startsWith('400 14px "Geist Variable", '))).toBe(true)
    expect(faces.some((face) => face.startsWith('400 13px "Geist Mono Variable", '))).toBe(true)
  })
})

describe('fontStack', () => {
  it('quotes the family and keeps the bundled fallbacks after it', () => {
    expect(fontStack('MesloLGS NF', TERMINAL_FONT_FALLBACK)).toBe(
      `"MesloLGS NF", ${TERMINAL_FONT_FALLBACK}`,
    )
  })

  it('strips characters that could break out of the declaration', () => {
    expect(fontStack('Evil"; } * {', CODE_FONT_FALLBACK)).toBe(`"Evil  *", ${CODE_FONT_FALLBACK}`)
    expect(fontStack('  ', CODE_FONT_FALLBACK)).toBe(CODE_FONT_FALLBACK)
  })

  it('tries Latin monos before CJK fonts, so a missing family keeps Latin cell metrics', () => {
    for (const stack of [TERMINAL_FONT_FALLBACK, CODE_FONT_FALLBACK]) {
      expect(stack.indexOf('"DejaVu Sans Mono"')).toBeLessThan(stack.indexOf('CJK'))
    }
  })
})

describe('font defaults', () => {
  it('uses 400 for UI, terminal and editor text, with emphasis carried by the weight tokens', () => {
    const { ui, terminal, editor } = useSettingsStore.getState().appearance
    expect([ui.weight, terminal.weight, editor.weight]).toEqual([400, 400, 400])
  })
})
