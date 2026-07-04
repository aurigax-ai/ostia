import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

/**
 * `settingsStore` mirrors settings.json (locale + per-surface fonts + behavior) and is the
 * ONLY writer of that file. The user story is persistence, so these tests exercise the two
 * real round-trips: `init()` MERGING a partial file over DEFAULTS (and surviving null /
 * invalid JSON), and the setters DEBOUNCING (300ms) a single `fs.write` of the clean
 * snapshot. The bridge (`window.pine.fs`/`settings.path`) is the shared `test/setup.ts`
 * fake; the debounce means the save tests run on FAKE TIMERS + the async timer API.
 */

const store = () => useSettingsStore.getState()

/** The persisted subset of the store state (locale + appearance + behavior). */
type Persisted = Pick<
  ReturnType<typeof useSettingsStore.getState>,
  'locale' | 'appearance' | 'behavior'
>

describe('settingsStore', () => {
  let initialState: ReturnType<typeof useSettingsStore.getState>
  // Snapshot of the store's baked-in DEFAULTS (the persisted subset), cloned so later
  // resets/mutations can never drift it — the source-of-truth for merge assertions.
  let DEFAULTS: Persisted

  beforeAll(() => {
    const s = useSettingsStore.getState()
    initialState = s
    DEFAULTS = structuredClone({ locale: s.locale, appearance: s.appearance, behavior: s.behavior })
  })

  beforeEach(() => {
    // The debounced save uses setTimeout — fake it so we can drive the 300ms window.
    vi.useFakeTimers()
    // `test/setup.ts` installs a fresh `window.pine` each test, but clear defensively so
    // call-count assertions start from zero.
    vi.mocked(window.pine.fs.write).mockClear()
  })

  afterEach(() => {
    // Real timers again — this also DISCARDS any pending debounced save so it can't leak.
    vi.useRealTimers()
    // Replace (not merge) back to pristine defaults + action fns so nothing bleeds across tests.
    useSettingsStore.setState(initialState, true)
  })

  describe('init', () => {
    it('merges a valid partial settings.json over DEFAULTS (mergeFont keeps default family)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(
        '{"locale":"zh-Hant","appearance":{"ui":{"size":16}}}',
      )

      await store().init()

      const s = store()
      expect(s.locale).toBe('zh-Hant')
      // ui.size came from the file; ui.family fell back to the default (mergeFont).
      expect(s.appearance.ui.size).toBe(16)
      expect(s.appearance.ui.family).toBe(DEFAULTS.appearance.ui.family)
      // Untouched surfaces + theme + behavior stay at defaults.
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
      // No `appearance`/`behavior` in the file → both fall back to the full DEFAULTS objects.
      expect(s.appearance).toEqual(DEFAULTS.appearance)
      expect(s.behavior).toEqual(DEFAULTS.behavior)
    })

    it('merges a family-only surface font over DEFAULTS (size falls back to default)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue('{"appearance":{"ui":{"family":"X"}}}')

      await store().init()

      const s = store()
      // Other mergeFont direction: family from the file, size from the default.
      expect(s.appearance.ui.family).toBe('X')
      expect(s.appearance.ui.size).toBe(DEFAULTS.appearance.ui.size)
    })

    it('keeps DEFAULTS when settings.json is absent (fs.read → null)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue(null)

      await store().init()

      const s = store()
      expect({ locale: s.locale, appearance: s.appearance, behavior: s.behavior }).toEqual(DEFAULTS)
    })

    it('keeps DEFAULTS when settings.json is invalid JSON (catch path)', async () => {
      vi.mocked(window.pine.fs.read).mockResolvedValue('not json{')

      await store().init()

      const s = store()
      expect({ locale: s.locale, appearance: s.appearance, behavior: s.behavior }).toEqual(DEFAULTS)
    })
  })

  describe('setters + debounced save', () => {
    it('setTheme updates appearance.theme immediately (before the debounce fires)', () => {
      store().setTheme('dracula')
      // Synchronous state change — assert without advancing timers.
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
      // Deep-equal the WHOLE persisted snapshot — a partial write (e.g. just {appearance:{theme}})
      // must fail, not slip through. Expected = DEFAULTS with only the theme changed.
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
      // The single write must carry the FULL final snapshot (both changed fields + all defaults).
      const expected = structuredClone(DEFAULTS)
      expected.locale = 'zh-Hant'
      expected.appearance.theme = 'dracula'
      expect(JSON.parse(write.mock.calls[0][1])).toEqual(expected)
    })

    it('setSurfaceFont merges the patch onto the existing surface font; setBehavior merges the patch', () => {
      store().setSurfaceFont('terminal', { size: 18 })
      const font = store().appearance.terminal
      expect(font.size).toBe(18)
      // Family untouched — merged, not replaced.
      expect(font.family).toBe(DEFAULTS.appearance.terminal.family)

      store().setBehavior({ cursorStyle: 'bar' })
      const behavior = store().behavior
      expect(behavior.cursorStyle).toBe('bar')
      // Other behavior fields preserved.
      expect(behavior.showHiddenFiles).toBe(DEFAULTS.behavior.showHiddenFiles)
      expect(behavior.cursorBlink).toBe(DEFAULTS.behavior.cursorBlink)
    })
  })
})
