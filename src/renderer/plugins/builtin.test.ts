import { describe, expect, it } from 'vitest'
import { en, zhHant } from '../i18n/dict'
import { BUILTIN_PLUGINS } from './builtin'
import type { Theme } from './types'

const themes = (): Theme[] => BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

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
  it('advertises exactly the five contracted theme ids', () => {
    const ids = themes()
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual(['adeberry', 'dracula', 'instrument-night', 'one-dark-vivid', 'oxocarbon'])
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
        contrast(tokens['fg-muted'], tokens['surface-2']),
        `${id} fg-muted`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(tokens['attn-fg'], tokens['surface-1']),
        `${id} attn-fg`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(tokens['fg-dim'], tokens['surface-1']),
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

  it('marks every theme as dark appearance', () => {
    for (const theme of themes()) {
      expect(theme.appearance, theme.id).toBe('dark')
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

  it('ties the English language pack to the real `en` catalog by reference', () => {
    const langs = plugin('pine.lang.en')?.contributes.languages
    expect(langs).toHaveLength(1)
    expect(langs?.[0].id).toBe('en')
    expect(langs?.[0].catalog).toBe(en)
  })

  it('ties the Traditional Chinese language pack to the real `zhHant` catalog by reference', () => {
    const langs = plugin('pine.lang.zh-hant')?.contributes.languages
    expect(langs).toHaveLength(1)
    expect(langs?.[0].id).toBe('zh-Hant')
    expect(langs?.[0].catalog).toBe(zhHant)
  })

  it('ships the LSP plugin with an initially empty languageServers array', () => {
    const servers = plugin('pine.lsp')?.contributes.languageServers
    expect(Array.isArray(servers)).toBe(true)
    expect(servers).toHaveLength(0)
  })
})
