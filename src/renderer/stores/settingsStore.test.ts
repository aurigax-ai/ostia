import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

const store = () => useSettingsStore.getState()

type Persisted = Pick<
  ReturnType<typeof useSettingsStore.getState>,
  | 'locale'
  | 'appearance'
  | 'behavior'
  | 'notifications'
  | 'sidebar'
  | 'workspaces'
  | 'browser'
  | 'editor'
  | 'keybindings'
  | 'terminal'
  | 'panes'
  | 'agents'
>

describe('settingsStore', () => {
  it('clamps the terminal line height and saves notification and sidebar changes', async () => {
    vi.useFakeTimers()
    store().setTerminalLineHeight(0.5)
    expect(store().appearance.terminal.lineHeight).toBe(1)
    store().setTerminalLineHeight(1.337)
    expect(store().appearance.terminal.lineHeight).toBe(1.34)
    store().setNotifications({ whenFocused: true })
    store().setSidebar({ showDescription: false })
    await vi.runAllTimersAsync()
    const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
    expect(written.notifications.whenFocused).toBe(true)
    expect(written.sidebar.showDescription).toBe(false)
    expect(written.appearance.terminal.lineHeight).toBe(1.34)
    vi.useRealTimers()
  })

  let initialState: ReturnType<typeof useSettingsStore.getState>
  let DEFAULTS: Persisted

  beforeAll(() => {
    const s = useSettingsStore.getState()
    initialState = s
    DEFAULTS = structuredClone({
      locale: s.locale,
      appearance: s.appearance,
      behavior: s.behavior,
      terminal: s.terminal,
      panes: s.panes,
      notifications: s.notifications,
      sidebar: s.sidebar,
      workspaces: s.workspaces,
      browser: s.browser,
      editor: s.editor,
      keybindings: s.keybindings,
      agents: s.agents,
      workspaceGroups: s.workspaceGroups,
      extensionSettings: s.extensionSettings,
    })
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(window.pine.fs.write).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    useSettingsStore.setState(initialState, true)
  })

  describe('appearance setters', () => {
    it('setAccent stores a normalized hex, clears on empty and rejects an invalid color', () => {
      expect(store().setAccent('#F80')).toBe(true)
      expect(store().appearance.accent).toBe('#ff8800')
      expect(store().setAccent('orange')).toBe(false)
      expect(store().appearance.accent).toBe('#ff8800')
      expect(store().setAccent('')).toBe(true)
      expect(store().appearance.accent).toBe('')
    })

    it('setZoom clamps to 80-150 and is saved to settings.json', async () => {
      store().setZoom(30)
      expect(store().appearance.zoom).toBe(80)
      store().setZoom(125)
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.appearance.zoom).toBe(125)
    })

    it('saves the follow-system choice with its light and dark themes', async () => {
      store().setFollowSystem(true)
      store().setLightTheme('pine-light')
      store().setDarkTheme('dracula')
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.appearance).toMatchObject({
        followSystem: true,
        lightTheme: 'pine-light',
        darkTheme: 'dracula',
      })
    })
  })

  describe('init', () => {
    it('keeps parseable keybindings and unbinds, and drops malformed entries', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          keybindings: {
            'palette.toggle': ' Ctrl+Shift+K ',
            'view.toggleRail': null,
            'history.search': 'Hyper+Q',
            'workspace.new': 42,
            'app.openSettings': 'Ctrl+R',
          },
        }),
      )
      await store().init()
      expect({ ...store().keybindings }).toEqual({
        'palette.toggle': 'Ctrl+Shift+K',
        'view.toggleRail': null,
        'app.openSettings': 'Ctrl+R',
      })
    })

    it('keeps a known input mode and falls back to terminal for anything else', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({ behavior: { inputMode: 'editor' } }),
      )
      await store().init()
      expect(store().behavior.inputMode).toBe('editor')

      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({ behavior: { inputMode: 'warp' } }),
      )
      await store().init()
      expect(store().behavior.inputMode).toBe('terminal')
    })

    it('reads workspace settings, dropping bad values and blank folders', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          workspaces: {
            placement: 'top',
            inheritFolder: true,
            defaultFolder: '  /work  ',
            confirmClose: false,
            confirmQuit: 'no',
            wrapTitles: true,
          },
        }),
      )
      await store().init()
      expect(store().workspaces).toEqual({
        placement: 'top',
        inheritFolder: true,
        defaultFolder: '/work',
        confirmClose: false,
        confirmQuit: true,
        wrapTitles: true,
      })

      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({ workspaces: { placement: 'middle', defaultFolder: '   ' } }),
      )
      await store().init()
      expect(store().workspaces.placement).toBe('end')
      expect(store().workspaces.defaultFolder).toBe('~')
    })

    it('reads notification, sidebar and line-height settings, clamping and dropping bad values', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          appearance: { terminal: { lineHeight: 5 } },
          behavior: { copyOnSelect: true },
          notifications: { sound: false, agentDone: 'nope' },
          sidebar: { showPath: false, showMessage: 1 },
        }),
      )

      await store().init()

      const s = store()
      expect(s.appearance.terminal.lineHeight).toBe(2)
      expect(s.behavior.copyOnSelect).toBe(true)
      expect(s.notifications.sound).toBe(false)
      expect(s.notifications.agentDone).toBe(true)
      expect(s.sidebar.showPath).toBe(false)
      expect(s.sidebar.showMessage).toBe(true)
    })

    it('reads browser and editor settings, dropping invalid values and clamping zoom', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          browser: { searchEngine: 'kagi', openTerminalLinks: true, defaultZoom: 900 },
          editor: { wordWrap: 'on', tabSize: 3, autoSave: 'afterDelay' },
        }),
      )

      await store().init()

      expect(store().browser).toMatchObject({
        searchEngine: 'kagi',
        openTerminalLinks: true,
        defaultZoom: 300,
      })
      expect(store().editor).toMatchObject({ wordWrap: 'on', tabSize: 2, autoSave: 'afterDelay' })
    })

    it('saves browser and editor changes', async () => {
      store().setBrowser({ searchEngine: 'custom', customSearchUrl: 'https://x.test/?q={query}' })
      store().setEditor({ formatOnSave: true, tabSize: 8 })
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.browser.searchEngine).toBe('custom')
      expect(written.browser.customSearchUrl).toBe('https://x.test/?q={query}')
      expect(written.editor).toMatchObject({ formatOnSave: true, tabSize: 8 })
    })
    it('reads follow-system, themes, accent and zoom, clamping the zoom and dropping a bad accent', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          appearance: {
            followSystem: true,
            lightTheme: 'dracula',
            darkTheme: 'oxocarbon',
            accent: '#F80',
            zoom: 999,
          },
          notifications: { command: 'say {title}' },
        }),
      )
      await store().init()
      expect(store().appearance).toMatchObject({
        followSystem: true,
        lightTheme: 'dracula',
        darkTheme: 'oxocarbon',
        accent: '#ff8800',
        zoom: 150,
      })
      expect(store().notifications.command).toBe('say {title}')

      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({ appearance: { followSystem: 'yes', accent: 'red', zoom: 'big' } }),
      )
      await store().init()
      expect(store().appearance).toMatchObject({ followSystem: false, accent: '', zoom: 100 })
    })
    it('reads hibernation settings off by default and clamps idle seconds and max live', async () => {
      expect(store().agents.hibernation).toEqual({
        enabled: false,
        idleSeconds: 600,
        maxLiveTerminals: 6,
      })
      expect(store().sidebar.showPorts).toBe(true)
      expect(store().sidebar.showSSH).toBe(true)
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          agents: { hibernation: { enabled: true, idleSeconds: 1, maxLiveTerminals: 900 } },
          sidebar: { showPorts: false },
        }),
      )

      await store().init()

      expect(store().agents.hibernation).toEqual({
        enabled: true,
        idleSeconds: 5,
        maxLiveTerminals: 64,
      })
      expect(store().sidebar.showPorts).toBe(false)
      expect(store().sidebar.showSSH).toBe(true)
    })
    it('keeps only well-formed workspace group rules from settings.json', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        JSON.stringify({
          workspaceGroups: {
            byCwd: [
              { pattern: '~/work/**', group: ' Work ' },
              { pattern: '', group: 'empty pattern' },
              { pattern: '/srv/*', group: '   ' },
              { pattern: 42, group: 'bad' },
              'nonsense',
            ],
          },
        }),
      )

      await store().init()

      expect(store().workspaceGroups.byCwd).toEqual([{ pattern: '~/work/**', group: 'Work' }])
    })

    it('sets workspace group rules by path and drops a malformed rule', () => {
      store().setByPath('workspaceGroups.byCwd', [
        { pattern: '/src/*', group: 'src' },
        { pattern: 3 },
      ])
      expect(store().workspaceGroups.byCwd).toEqual([{ pattern: '/src/*', group: 'src' }])
    })

    it('merges a valid partial settings.json over DEFAULTS (mergeFont keeps default family)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        '{"locale":"zh-Hant","appearance":{"ui":{"size":16}}}',
      )

      await store().init()

      const s = store()
      expect(s.locale).toBe('zh-Hant')
      expect(s.appearance.ui.size).toBe(16)
      expect(s.appearance.ui.family).toBe(DEFAULTS.appearance.ui.family)
      expect(s.appearance.theme).toBe(DEFAULTS.appearance.theme)
      expect(s.appearance.terminal).toEqual(DEFAULTS.appearance.terminal)
      expect(s.appearance.editor).toEqual(DEFAULTS.appearance.editor)
      expect(s.behavior).toEqual(DEFAULTS.behavior)
    })

    it('fills whole missing nested objects from DEFAULTS (file has only locale)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue('{"locale":"zh-Hant"}')

      await store().init()

      const s = store()
      expect(s.locale).toBe('zh-Hant')
      expect(s.appearance).toEqual(DEFAULTS.appearance)
      expect(s.behavior).toEqual(DEFAULTS.behavior)
    })

    it('merges a family-only surface font over DEFAULTS (size falls back to default)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue('{"appearance":{"ui":{"family":"X"}}}')

      await store().init()

      const s = store()
      expect(s.appearance.ui.family).toBe('X')
      expect(s.appearance.ui.size).toBe(DEFAULTS.appearance.ui.size)
    })

    it('keeps DEFAULTS when settings.json is absent (fs.read → null)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(null)

      await store().init()

      const s = store()
      expect({
        locale: s.locale,
        appearance: s.appearance,
        behavior: s.behavior,
        terminal: s.terminal,
        panes: s.panes,
        notifications: s.notifications,
        sidebar: s.sidebar,
        workspaces: s.workspaces,
        browser: s.browser,
        editor: s.editor,
        keybindings: s.keybindings,
        agents: s.agents,
        workspaceGroups: s.workspaceGroups,
        extensionSettings: s.extensionSettings,
      }).toEqual(DEFAULTS)
    })

    it('round-trips extensionSettings and saves what main stored for an extension', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        '{"extensionSettings":{"git":{"fetch":true},"__proto__":{"x":1},"bad":[1]}}',
      )

      await store().init()
      expect(store().extensionSettings).toEqual({ git: { fetch: true } })
      store().setExtensionSettings('ports', { interval: 5 })
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.pine.fs.write).mock.calls[0][1])
      expect(written.extensionSettings).toEqual({ git: { fetch: true }, ports: { interval: 5 } })
    })

    it('keeps capabilities.grants from settings.json so a later save round-trips it', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        '{"locale":"en","capabilities":{"grants":["browse","gateway"]}}',
      )

      await store().init()
      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.pine.fs.write).mock.calls[0][1])
      expect(written.capabilities).toEqual({ grants: ['browse', 'gateway'] })
      expect(written.appearance.theme).toBe('dracula')
    })

    it('keeps DEFAULTS when settings.json is invalid JSON (catch path)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue('not json{')

      await store().init()

      const s = store()
      expect({
        locale: s.locale,
        appearance: s.appearance,
        behavior: s.behavior,
        terminal: s.terminal,
        panes: s.panes,
        notifications: s.notifications,
        sidebar: s.sidebar,
        workspaces: s.workspaces,
        browser: s.browser,
        editor: s.editor,
        keybindings: s.keybindings,
        agents: s.agents,
        workspaceGroups: s.workspaceGroups,
        extensionSettings: s.extensionSettings,
      }).toEqual(DEFAULTS)
    })
  })

  describe('setters + debounced save', () => {
    it('setHibernation clamps and saves the agents group', async () => {
      store().setHibernation({ enabled: true, idleSeconds: 90.4 })
      store().setHibernation({ maxLiveTerminals: -3 })
      await vi.advanceTimersByTimeAsync(300)
      const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.agents.hibernation).toEqual({
        enabled: true,
        idleSeconds: 90,
        maxLiveTerminals: 0,
      })
    })

    it('setTheme updates appearance.theme immediately (before the debounce fires)', () => {
      store().setTheme('dracula')
      expect(store().appearance.theme).toBe('dracula')
    })

    it('debounced save writes the COMPLETE snapshot (theme dracula) to the settings path, newline-terminated', async () => {
      store().setTheme('dracula')

      await vi.advanceTimersByTimeAsync(300)

      const write = vi.mocked(window.pine.fs.write)
      expect(write).toHaveBeenCalledTimes(1)
      expect(window.pine.settings.path).toHaveBeenCalled()
      const [pathArg, contentArg] = write.mock.calls[0]
      expect(pathArg).toBe('/tmp/pine-test/settings.json')
      expect(typeof contentArg).toBe('string')
      expect(contentArg.endsWith('\n')).toBe(true)
      const expected = structuredClone(DEFAULTS)
      expected.appearance.theme = 'dracula'
      expect(JSON.parse(contentArg)).toEqual(expected)
    })

    it('coalesces back-to-back setters into ONE write of the COMPLETE final snapshot', async () => {
      store().setTheme('dracula')
      store().setLocale('zh-Hant')

      await vi.advanceTimersByTimeAsync(300)

      const write = vi.mocked(window.pine.fs.write)
      expect(write).toHaveBeenCalledTimes(1)
      const expected = structuredClone(DEFAULTS)
      expected.locale = 'zh-Hant'
      expected.appearance.theme = 'dracula'
      expect(JSON.parse(write.mock.calls[0][1])).toEqual(expected)
    })

    it('setSurfaceFont merges the patch onto the existing surface font; setBehavior merges the patch', () => {
      store().setSurfaceFont('terminal', { size: 18 })
      const font = store().appearance.terminal
      expect(font.size).toBe(18)
      expect(font.family).toBe(DEFAULTS.appearance.terminal.family)

      store().setBehavior({ cursorStyle: 'bar' })
      const behavior = store().behavior
      expect(behavior.cursorStyle).toBe('bar')
      expect(behavior.showHiddenFiles).toBe(DEFAULTS.behavior.showHiddenFiles)
      expect(behavior.cursorBlink).toBe(DEFAULTS.behavior.cursorBlink)
    })
  })

  describe('setByPath', () => {
    it('deep-sets an existing nested path, preserving sibling values', () => {
      store().setByPath('appearance.terminal.size', 20)
      expect(store().appearance.terminal.size).toBe(20)
      expect(store().appearance.terminal.family).toBe(DEFAULTS.appearance.terminal.family)
      expect(store().appearance.ui).toEqual(DEFAULTS.appearance.ui)
    })

    it.each(['plugins.myPlugin.enabled', 'init', 'setTheme', 'setByPath'])(
      'rejects %s (not under a settings data key) without mutating state',
      (path) => {
        const before = store()
        expect(() => store().setByPath(path, true)).toThrow(/unknown settings key/)
        expect(store()).toBe(before)
        expect(typeof store().init).toBe('function')
      },
    )

    it('rejects replacing an object with a primitive', () => {
      expect(() => store().setByPath('appearance.terminal', 12)).toThrow(
        'cannot set appearance.terminal: expected object, got number',
      )
      expect(store().appearance.terminal).toEqual(DEFAULTS.appearance.terminal)
    })

    it('rejects changing a leaf type (number to string)', () => {
      expect(() => store().setByPath('appearance.terminal.size', 'big')).toThrow(
        'expected number, got string',
      )
      expect(store().appearance.terminal.size).toBe(DEFAULTS.appearance.terminal.size)
    })

    it('rejects descending into a primitive', () => {
      expect(() => store().setByPath('locale.nested', 'x')).toThrow(
        'cannot set locale.nested: locale is string, not an object',
      )
      expect(store().locale).toBe(DEFAULTS.locale)
    })

    it('refuses capabilities.grants so an agent cannot elevate itself', () => {
      expect(() => store().setByPath('capabilities.grants', ['browse'])).toThrow(
        'unknown settings key',
      )
      expect(store().capabilities).toBeUndefined()
    })

    it.each(['__proto__', 'prototype', 'constructor'])(
      'rejects a path with a dangerous %s segment WITHOUT mutating state',
      (segment) => {
        const before = structuredClone(DEFAULTS)
        expect(() => store().setByPath(`appearance.${segment}.polluted`, 'evil')).toThrow()
        const after = store()
        expect(after.appearance).toEqual(before.appearance)
        expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false)
      },
    )

    it('rejects a bare dangerous top-level segment', () => {
      expect(() => store().setByPath('__proto__', { polluted: true })).toThrow()
      expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false)
    })

    it('does not schedule a save when the path is rejected', async () => {
      expect(() => store().setByPath('constructor.prototype.polluted', 'evil')).toThrow()
      await vi.advanceTimersByTimeAsync(300)
      expect(window.pine.fs.write).not.toHaveBeenCalled()
    })
  })
})
