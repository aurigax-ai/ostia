import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { en } from '../i18n/dict'
import { BASE_LANGUAGE } from '../lib/languagePacks'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import { usePluginsStore } from './pluginsStore'

const store = () => usePluginsStore.getState()

describe('pluginsStore', () => {
  let initialState: ReturnType<typeof usePluginsStore.getState>

  beforeAll(() => {
    initialState = usePluginsStore.getState()
  })

  afterEach(() => {
    usePluginsStore.setState(initialState, true)
  })

  describe('registry seed', () => {
    it('seeds the built-in plugins in manifest order, all marked builtin', () => {
      expect(store().plugins).toBe(BUILTIN_PLUGINS)
      expect(store().plugins.map((p) => p.id)).toEqual(['pine.themes'])
      expect(store().plugins.every((p) => p.builtin)).toBe(true)
    })
  })

  describe('derived themes', () => {
    it('aggregates contributes.themes across plugins (only pine.themes contributes any)', () => {
      const themePlugin = BUILTIN_PLUGINS.find((p) => p.id === 'pine.themes')
      expect(store().themes).toEqual(themePlugin?.contributes.themes)
      expect(store().themes.map((t) => t.id)).toEqual([
        'adeberry',
        'one-dark-vivid',
        'instrument-night',
        'dracula',
        'oxocarbon',
        'pine-light',
      ])
    })

    it('resolves a theme by id from the derived list as a full Theme object', () => {
      const dracula = store().themes.find((t) => t.id === 'dracula')
      expect(dracula).toMatchObject({
        id: 'dracula',
        name: 'Dracula',
        appearance: 'dark',
      })
      expect(dracula?.tokens.brand).toBe('#bd93f9')
    })

    it('has no entry for an unknown theme id', () => {
      expect(store().themes.find((t) => t.id === 'no-such-theme')).toBeUndefined()
    })
  })

  describe('languages', () => {
    it('offers only English until language packs are loaded', () => {
      expect(store().languages.map((l) => l.id)).toEqual(['en'])
      expect(store().languages[0]?.catalog).toBe(BASE_LANGUAGE.catalog)
    })

    it('adds the language packs main returns, translated over English', async () => {
      vi.mocked(window.pine.languagePacks.load).mockResolvedValue([
        {
          extId: 'langpack-zh-hant',
          id: 'zh-Hant',
          label: '繁體中文',
          catalog: { settings: { title: '設定' } },
        },
      ])
      await store().loadLanguages()
      expect(store().languages.map((l) => [l.id, l.label])).toEqual([
        ['en', 'English'],
        ['zh-Hant', '繁體中文'],
      ])
      const zh = store().languages[1]?.catalog
      expect(zh?.settings.title).toBe('設定')
      expect(zh?.settings.search).toBe(en.settings.search)
    })

    it('drops a pack again when main no longer returns it', async () => {
      vi.mocked(window.pine.languagePacks.load).mockResolvedValue([
        { extId: 'x', id: 'fr', label: 'Français', catalog: {} },
      ])
      await store().loadLanguages()
      vi.mocked(window.pine.languagePacks.load).mockResolvedValue([])
      await store().loadLanguages()
      expect(store().languages.map((l) => l.id)).toEqual(['en'])
    })
  })
})
