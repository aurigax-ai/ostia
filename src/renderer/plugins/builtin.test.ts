import { describe, expect, it } from 'vitest'
import { en, zhHant } from '../i18n/dict'
import { BUILTIN_PLUGINS } from './builtin'
import type { Theme } from './types'

/** All themes contributed across the built-in plugin set (flattened). */
const themes = (): Theme[] => BUILTIN_PLUGINS.flatMap((p) => p.contributes.themes ?? [])

/** The single plugin with a given id (or undefined). */
const plugin = (id: string) => BUILTIN_PLUGINS.find((p) => p.id === id)

/**
 * The token keys the design system requires on every theme. `Theme.tokens` is typed as an
 * open `Record<string, string>` (types.ts), so the compiler enforces nothing here — this
 * list IS the product contract, pinned independently of the themes so a uniform missing/extra
 * token across all four still fails the completeness check.
 */
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
  'ok',
  'add',
  'del',
].sort()

describe('BUILTIN_PLUGINS', () => {
  it('advertises exactly the five contracted theme ids', () => {
    // These ids are the product contract — the settings schema's `theme` description
    // enumerates them, so a rename/removal here silently breaks that reference.
    const ids = themes()
      .map((t) => t.id)
      .sort()
    expect(ids).toEqual(['adeberry', 'dracula', 'instrument-night', 'one-dark-vivid', 'oxocarbon'])
  })

  it('gives every theme exactly the required token-key set (no missing, no extra tokens)', () => {
    // Pinned against REQUIRED_TOKEN_KEYS (not themes[0]) so a token dropped/added uniformly
    // across all themes still fails. A theme missing a token would render with an undefined
    // CSS var → broken UI.
    for (const theme of themes()) {
      expect(Object.keys(theme.tokens).sort(), `theme ${theme.id} token keys`).toEqual(
        REQUIRED_TOKEN_KEYS,
      )
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
    // Same object reference — not a structural copy — so runtime lookups hit the live dict.
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
