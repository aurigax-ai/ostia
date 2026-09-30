import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  clampContrast,
  clampScrollSpeed,
  clampScrollback,
  isRiskyPaste,
  parsePaneSettings,
  parseTerminalSettings,
  pastePreview,
} from './terminalPaneSettings'

describe('clampScrollSpeed', () => {
  it('keeps values in 0.5 to 5 and rounds to one decimal', () => {
    expect(clampScrollSpeed(0.1)).toBe(0.5)
    expect(clampScrollSpeed(9)).toBe(5)
    expect(clampScrollSpeed(1.26)).toBe(1.3)
  })

  it('falls back to the default for non-numbers', () => {
    expect(clampScrollSpeed('fast')).toBe(1)
    expect(clampScrollSpeed(Number.NaN)).toBe(1)
    expect(clampScrollSpeed(undefined)).toBe(1)
  })
})

describe('clampScrollback', () => {
  it('keeps whole numbers in 1000 to 100000', () => {
    expect(clampScrollback(10)).toBe(1000)
    expect(clampScrollback(5_000_000)).toBe(100000)
    expect(clampScrollback(2500.6)).toBe(2501)
  })

  it('falls back to 10000 for non-numbers and Infinity', () => {
    expect(clampScrollback('lots')).toBe(10000)
    expect(clampScrollback(Number.POSITIVE_INFINITY)).toBe(10000)
  })
})

describe('clampContrast', () => {
  it('keeps values in 1 to 21', () => {
    expect(clampContrast(0)).toBe(1)
    expect(clampContrast(40)).toBe(21)
    expect(clampContrast(4.55)).toBe(4.6)
  })
})

describe('parseTerminalSettings', () => {
  it('returns defaults for a missing or malformed section', () => {
    expect(parseTerminalSettings(undefined)).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(parseTerminalSettings([1])).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })

  it('clamps numbers and drops non-boolean flags', () => {
    expect(
      parseTerminalSettings({
        scrollSpeed: 99,
        scrollbackLines: 3,
        minimumContrast: 'x',
        warnOnRiskyPaste: 'no',
      }),
    ).toEqual({
      scrollSpeed: 5,
      scrollbackLines: 1000,
      minimumContrast: 1,
      warnOnRiskyPaste: true,
      prompt: DEFAULT_TERMINAL_SETTINGS.prompt,
    })
  })

  it('keeps a valid off switch', () => {
    expect(parseTerminalSettings({ warnOnRiskyPaste: false }).warnOnRiskyPaste).toBe(false)
  })
})

describe('parsePaneSettings', () => {
  it('returns defaults for a missing section', () => {
    expect(parsePaneSettings(null)).toEqual(DEFAULT_PANE_SETTINGS)
  })

  it('keeps booleans and ignores everything else', () => {
    expect(parsePaneSettings({ dimInactive: false, focusOnHover: 1, hideTabClose: true })).toEqual({
      dimInactive: false,
      focusOnHover: false,
      equalizeOnSplit: false,
      hideTabClose: true,
    })
  })
})

describe('isRiskyPaste', () => {
  it('flags text with a newline or carriage return', () => {
    expect(isRiskyPaste('ls\n')).toBe(true)
    expect(isRiskyPaste('a\r\nb')).toBe(true)
  })

  it('flags escape and other control characters', () => {
    expect(isRiskyPaste('\x1b[201~rm -rf')).toBe(true)
    expect(isRiskyPaste('a\x07b')).toBe(true)
    expect(isRiskyPaste('a\x7fb')).toBe(true)
  })

  it('accepts a single plain line, tabs included', () => {
    expect(isRiskyPaste('git status -sb')).toBe(false)
    expect(isRiskyPaste('a\tb')).toBe(false)
    expect(isRiskyPaste('')).toBe(false)
  })
})

describe('pastePreview', () => {
  it('shows escape and control characters visibly and keeps newlines', () => {
    expect(pastePreview('a\x1bb\x07c\nd')).toBe('a␛b\\x07c\nd')
  })

  it('truncates long text', () => {
    const preview = pastePreview('x'.repeat(5000))
    expect(preview.length).toBe(2001)
    expect(preview.endsWith('…')).toBe(true)
  })
})
