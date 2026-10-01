import { describe, expect, it } from 'vitest'
import { en, zhHant } from '../i18n/dict'
import { languagesFrom, mergeCatalog } from './languagePacks'

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
    expect(dict).toEqual(en)
  })

  it('reproduces the full Traditional Chinese catalog from its JSON form', () => {
    expect(mergeCatalog(JSON.parse(JSON.stringify(zhHant)))).toEqual(zhHant)
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
    expect(languages[0]?.catalog).toBe(en)
  })
})
