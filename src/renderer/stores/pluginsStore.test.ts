import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
    it('seeds the four built-in plugins in manifest order, all marked builtin', () => {
      expect(store().plugins).toBe(BUILTIN_PLUGINS)
      expect(store().plugins.map((p) => p.id)).toEqual([
        'pine.themes',
        'pine.lsp',
        'pine.langpack.en',
        'pine.langpack.zh-hant',
      ])
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

  describe('derived languages', () => {
    it('aggregates contributes.languages across plugins (en + zh-Hant packs)', () => {
      expect(store().languages.map((l) => l.id)).toEqual(['en', 'zh-Hant'])
      expect(store().languages.map((l) => l.label)).toEqual(['English', '繁體中文'])
      for (const lang of store().languages) {
        expect(typeof lang.catalog).toBe('object')
        expect(Object.keys(lang.catalog).length).toBeGreaterThan(0)
      }
    })
  })

  describe('lsp: initial state + load()', () => {
    it('starts with an empty lsp list and loaded=false', () => {
      expect(store().lsp).toEqual([])
      expect(store().loaded).toBe(false)
    })

    it('maps lsp:list results to entries (installed→installed, not-installed→missing) and sets loaded', async () => {
      vi.mocked(window.pine.lsp.list).mockResolvedValue([
        { languageId: 'typescript', command: 'typescript-language-server', installed: true },
        { languageId: 'python', command: 'pylsp', installed: false },
      ])

      await store().load()

      expect(store().loaded).toBe(true)
      expect(store().lsp).toEqual([
        { languageId: 'typescript', command: 'typescript-language-server', status: 'installed' },
        { languageId: 'python', command: 'pylsp', status: 'missing' },
      ])
      expect(window.pine.lsp.list).toHaveBeenCalledTimes(1)
    })

    it('marks loaded even when main reports no configured servers', async () => {
      await store().load()

      expect(store().loaded).toBe(true)
      expect(store().lsp).toEqual([])
      expect(window.pine.lsp.list).toHaveBeenCalledTimes(1)
    })

    it('is idempotent — a second load() does not re-fetch from main', async () => {
      await store().load()
      expect(window.pine.lsp.list).toHaveBeenCalledTimes(1)

      vi.mocked(window.pine.lsp.list).mockClear()
      await store().load()

      expect(window.pine.lsp.list).not.toHaveBeenCalled()
    })
  })

  describe('setLspStatus', () => {
    it('updates the matching entry and leaves the others untouched', async () => {
      vi.mocked(window.pine.lsp.list).mockResolvedValue([
        { languageId: 'typescript', command: 'typescript-language-server', installed: true },
        { languageId: 'python', command: 'pylsp', installed: false },
      ])
      await store().load()

      store().setLspStatus('python', 'running')

      const byId = Object.fromEntries(store().lsp.map((e) => [e.languageId, e.status]))
      expect(byId.python).toBe('running')
      expect(byId.typescript).toBe('installed')
    })

    it('is a no-op for an unknown languageId', async () => {
      vi.mocked(window.pine.lsp.list).mockResolvedValue([
        { languageId: 'typescript', command: 'typescript-language-server', installed: true },
      ])
      await store().load()
      const before = store().lsp

      store().setLspStatus('rust', 'running')

      expect(store().lsp).toEqual(before)
    })

    it('is a safe no-op when called before load() (empty list)', () => {
      store().setLspStatus('typescript', 'running')
      expect(store().lsp).toEqual([])
    })
  })
})
