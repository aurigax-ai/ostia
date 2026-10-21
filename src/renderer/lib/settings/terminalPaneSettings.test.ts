import { describe, expect, it } from 'vitest'
import {
  clampContrast,
  clampScrollback,
  clampScrollSpeed,
  DEFAULT_PANE_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  parsePaneSettings,
  parseTerminalSettings,
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
        scrollbackHistory: 8,
        minimumContrast: 'x',
        warnOnRiskyPaste: 'no',
      }),
    ).toEqual({
      scrollSpeed: 5,
      scrollbackLines: 1000,
      scrollbackHistory: 64,
      minimumContrast: 1,
      warnOnRiskyPaste: true,
      prompt: DEFAULT_TERMINAL_SETTINGS.prompt,
      clipboardKeys: 'shift',
      linkClick: 'app',
      theme: 'match',
      shell: '',
      osc52Write: true,
      keepShells: false,
      primarySelection: true,
      macOptionIsMeta: false,
      renderer: 'xterm',
    })
  })

  it('keeps history on disk off, unlimited or a whole number of MiB', () => {
    expect(parseTerminalSettings({}).scrollbackHistory).toBe('unlimited')
    expect(parseTerminalSettings({ scrollbackHistory: 'off' }).scrollbackHistory).toBe('off')
    expect(parseTerminalSettings({ scrollbackHistory: 2048.4 }).scrollbackHistory).toBe(2048)
    expect(parseTerminalSettings({ scrollbackHistory: 'all' }).scrollbackHistory).toBe('unlimited')
  })

  it('keeps a known terminal renderer and falls back to xterm for anything else', () => {
    expect(parseTerminalSettings({ renderer: 'ghostty' }).renderer).toBe('ghostty')
    expect(parseTerminalSettings({ renderer: 'kitty' }).renderer).toBe('xterm')
    expect(parseTerminalSettings({ renderer: 1 }).renderer).toBe('xterm')
  })

  it('keeps the smart clipboard keys mode', () => {
    expect(parseTerminalSettings({ clipboardKeys: 'smart' }).clipboardKeys).toBe('smart')
    expect(parseTerminalSettings({ linkClick: 'system' }).linkClick).toBe('system')
    expect(parseTerminalSettings({ linkClick: 'browser' }).linkClick).toBe('app')
  })

  it('keeps the shell command as trimmed text and drops a non-string one', () => {
    expect(parseTerminalSettings({ shell: '  /usr/bin/fish -l ' }).shell).toBe('/usr/bin/fish -l')
    expect(parseTerminalSettings({ shell: ['fish'] }).shell).toBe('')
  })

  it('keeps a picked color scheme and links an empty, oversized or non-string one', () => {
    expect(parseTerminalSettings({ theme: ' nord ' }).theme).toBe('nord')
    expect(parseTerminalSettings({ theme: '' }).theme).toBe('match')
    expect(parseTerminalSettings({ theme: 42 }).theme).toBe('match')
    expect(parseTerminalSettings({ theme: 'x'.repeat(81) }).theme).toBe('match')
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
