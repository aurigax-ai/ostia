import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { describe, expect, it } from 'vitest'
import { en, withProductName, zhHant } from '../i18n/dict'
import { BASE_LANGUAGE, languagesFrom, mergeCatalog } from './languagePacks'

describe('mergeCatalog', () => {
  it('uses the translation where there is one and English everywhere else', () => {
    const dict = mergeCatalog({ settings: { title: 'Réglages' } })
    expect(dict.settings.title).toBe('Réglages')
    expect(dict.settings.search).toBe(en.settings.search)
    expect(dict.pane).toEqual(en.pane)
  })

  it('ignores keys English does not have and values of the wrong shape', () => {
    const dict = mergeCatalog({
      settings: 'not a group',
      pane: { tabs: { nested: 'not a string' }, invented: 'x' },
      invented: { a: 'b' },
    })
    expect(dict).toEqual(BASE_LANGUAGE.catalog)
  })

  it('reproduces the full Traditional Chinese catalog from its JSON form', () => {
    const named = JSON.parse(withProductName(JSON.stringify(zhHant)))
    expect(mergeCatalog(JSON.parse(JSON.stringify(zhHant)))).toEqual(named)
  })

  it('names the product in English and in a pack, wherever a string writes {product}', () => {
    const dict = mergeCatalog({ update: { title: '{product} 已更新' } })
    expect(dict.update.title).toBe(`${PRODUCT_DISPLAY_NAME} 已更新`)
    expect(dict.sandbox.pineAccess).toBe(`${PRODUCT_DISPLAY_NAME} access`)
    expect(JSON.stringify(mergeCatalog(JSON.parse(JSON.stringify(zhHant))))).not.toContain(
      '{product}',
    )
  })
})

describe('languagesFrom', () => {
  it('lists English first and never lets a pack replace it or repeat a language', () => {
    const languages = languagesFrom([
      { extId: 'a', id: 'en', label: 'Fake English', catalog: { settings: { title: 'X' } } },
      { extId: 'b', id: 'fr', label: 'Français', catalog: {} },
      { extId: 'c', id: 'fr', label: 'Autre', catalog: {} },
    ])
    expect(languages.map((l) => [l.id, l.label])).toEqual([
      ['en', 'English'],
      ['fr', 'Français'],
    ])
    expect(languages[0]?.catalog).toBe(BASE_LANGUAGE.catalog)
  })
})
