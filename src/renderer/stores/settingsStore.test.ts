import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

const store = () => useSettingsStore.getState()

type Persisted = Pick<
  ReturnType<typeof useSettingsStore.getState>,
  'locale' | 'appearance' | 'behavior' | 'notifications' | 'sidebar' | 'agents'
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
      notifications: s.notifications,
      sidebar: s.sidebar,
      agents: s.agents,
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

  describe('init', () => {
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
        notifications: s.notifications,
        sidebar: s.sidebar,
        agents: s.agents,
      }).toEqual(DEFAULTS)
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
        notifications: s.notifications,
        sidebar: s.sidebar,
        agents: s.agents,
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
