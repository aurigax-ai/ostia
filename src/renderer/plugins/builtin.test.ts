import { wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from './builtin'
import type { Theme } from './types'

const themes = (): Theme[] => BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])

const plugin = (id: string) => BUILTIN_PLUGINS.find((p) => p.id === id)

const REQUIRED_TOKEN_KEYS = [
  'bg',
  'bg-sunken',
  'surface-1',
  'surface-2',
  'surface-3',
  'line',
  'line-strong',
  'fg',
  'fg-muted',
  'fg-dim',
  'brand',
  'brand-bright',
  'brand-glow',
  'attn',
  'attn-glow',
  'attn-fg',
  'ok',
  'add',
  'del',
].sort()

describe('BUILTIN_PLUGINS', () => {
  it('advertises exactly the six contracted theme ids', () => {
    const ids = themes()
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual([
      'adeberry',
      'dracula',
      'instrument-night',
      'one-dark-vivid',
      'oxocarbon',
      'pine-light',
    ])
  })

  it('gives every theme exactly the required token-key set (no missing, no extra tokens)', () => {
    for (const theme of themes()) {
      expect(Object.keys(theme.tokens).sort(), `theme ${theme.id} token keys`).toEqual(
        REQUIRED_TOKEN_KEYS,
      )
    }
  })

  it('keeps text tokens readable on the surfaces they sit on', () => {
    for (const { id, tokens } of themes()) {
      expect(
        wcagContrast(tokens['fg-muted'], tokens['surface-2']),
        `${id} fg-muted`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        wcagContrast(tokens['attn-fg'], tokens['surface-1']),
        `${id} attn-fg`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        wcagContrast(tokens['fg-dim'], tokens['surface-1']),
        `${id} fg-dim`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('gives every token a non-empty string value', () => {
    for (const theme of themes()) {
      for (const [key, value] of Object.entries(theme.tokens)) {
        expect(typeof value, `${theme.id}.${key}`).toBe('string')
        expect(value.length, `${theme.id}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('marks every theme as dark except pine-light', () => {
    for (const theme of themes()) {
      expect(theme.appearance, theme.id).toBe(theme.id === 'pine-light' ? 'light' : 'dark')
    }
  })

  it('keeps every text token of the light theme at 4.5:1 or better on all its surfaces', () => {
    const { tokens } = themes().find((t) => t.id === 'pine-light') as Theme
    const surfaces = ['bg', 'bg-sunken', 'surface-1', 'surface-2', 'surface-3']
    for (const text of ['fg', 'fg-muted', 'brand', 'brand-bright', 'attn-fg', 'ok']) {
      for (const surface of surfaces) {
        expect(
          wcagContrast(tokens[text], tokens[surface]),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('has unique plugin ids, each builtin with a non-empty name and a version', () => {
    const ids = BUILTIN_PLUGINS.map((p) => p.id)
    expect(new Set(ids).size, 'duplicate plugin id').toBe(ids.length)
    for (const p of BUILTIN_PLUGINS) {
      expect(p.builtin, p.id).toBe(true)
      expect(p.name.length, p.id).toBeGreaterThan(0)
      expect(p.version.length, p.id).toBeGreaterThan(0)
    }
  })

  it('ships the LSP plugin with an initially empty languageServers array', () => {
    const servers = plugin('pine.lsp')?.contributes.languageServers
    expect(Array.isArray(servers)).toBe(true)
    expect(servers).toHaveLength(0)
  })
})
