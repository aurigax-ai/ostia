import { create } from 'zustand'
import { isDangerousSegment } from '../../shared/protoGuard'
import type { Locale } from '../i18n/dict'

/** Theme id — resolved against the theme registry (built-in + plugin contributions). */
export type ThemeId = string

/** Per-surface font config (docs/DESIGN.md — UI / terminal / editor are independent). */
export interface SurfaceFont {
  family: string
  size: number
}

export interface Appearance {
  theme: ThemeId
  ui: SurfaceFont
  terminal: SurfaceFont
  editor: SurfaceFont
}

/** Terminal cursor shape (maps to xterm's cursorStyle). */
export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: CursorStyle[] = ['block', 'underline', 'bar']

/** Behavior toggles (the schema-driven settings). */
export interface Behavior {
  showHiddenFiles: boolean
  cursorStyle: CursorStyle
  cursorBlink: boolean
  /**
   * Reopen the previous run's sessions, panes and terminal scrollback at launch
   * (`stores/persistence.ts` + `main/sessionSnapshot.ts`). Shells are always respawned
   * fresh — this restores the workspace's shape and history, not live processes. Turning it
   * off also ERASES what's already stored, rather than leaving a stale copy on disk.
   */
  restoreSession: boolean
}

export type FontSurface = 'ui' | 'terminal' | 'editor'

/** The persisted shape — exactly what settings.json holds (hand-editable + JSON-Schema'd). */
interface Persisted {
  locale: Locale
  appearance: Appearance
  behavior: Behavior
}

const DEFAULTS: Persisted = {
  locale: 'en',
  appearance: {
    theme: 'adeberry',
    ui: { family: 'Inter Variable', size: 13 },
    terminal: { family: 'Hack Nerd Font Mono', size: 13 },
    editor: { family: 'Geist Mono Variable', size: 13 },
  },
  behavior: {
    showHiddenFiles: true,
    cursorStyle: 'block',
    cursorBlink: true,
    restoreSession: true,
  },
}

interface SettingsState extends Persisted {
  /** Load values from settings.json (call once at startup). */
  init: () => Promise<void>
  setLocale: (l: Locale) => void
  setTheme: (t: ThemeId) => void
  setSurfaceFont: (surface: FontSurface, patch: Partial<SurfaceFont>) => void
  setBehavior: (patch: Partial<Behavior>) => void
  /**
   * Deep-set a dot-path (e.g. `appearance.terminal.size`) into the settings state,
   * immutably, then schedule a save. The primitive behind the agent-facing
   * `settings.set` command — tolerates unknown paths by creating the leaf rather
   * than throwing, since an agent may set a key the schema doesn't know about yet.
   */
  setByPath: (path: string, value: unknown) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Debounced write of the clean settings object to settings.json. */
function scheduleSave(get: () => SettingsState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const s = get()
    const snapshot: Persisted = { locale: s.locale, appearance: s.appearance, behavior: s.behavior }
    const path = await window.pine.settings.path()
    await window.pine.fs.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
  }, 300)
}

const mergeFont = (base: SurfaceFont, p?: Partial<SurfaceFont>): SurfaceFont => ({ ...base, ...p })

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,

  init: async () => {
    const path = await window.pine.settings.path()
    const raw = await window.pine.fs.read(path)
    if (!raw) return
    try {
      const p = JSON.parse(raw) as Partial<Persisted>
      set({
        locale: p.locale ?? DEFAULTS.locale,
        appearance: {
          theme: p.appearance?.theme ?? DEFAULTS.appearance.theme,
          ui: mergeFont(DEFAULTS.appearance.ui, p.appearance?.ui),
          terminal: mergeFont(DEFAULTS.appearance.terminal, p.appearance?.terminal),
          editor: mergeFont(DEFAULTS.appearance.editor, p.appearance?.editor),
        },
        behavior: { ...DEFAULTS.behavior, ...p.behavior },
      })
    } catch {
      // invalid JSON in settings.json → keep defaults (the editor's schema will flag it)
    }
  },

  setLocale: (locale) => {
    set({ locale })
    scheduleSave(get)
  },
  setTheme: (theme) => {
    set((s) => ({ appearance: { ...s.appearance, theme } }))
    scheduleSave(get)
  },
  setSurfaceFont: (surface, patch) => {
    set((s) => ({
      appearance: { ...s.appearance, [surface]: { ...s.appearance[surface], ...patch } },
    }))
    scheduleSave(get)
  },
  setBehavior: (patch) => {
    set((s) => ({ behavior: { ...s.behavior, ...patch } }))
    scheduleSave(get)
  },
  setByPath: (path, value) => {
    const keys = path.split('.').filter(Boolean)
    if (keys.length === 0) return
    // Prototype-pollution guard: reject the whole path (mutating nothing) if ANY segment
    // is `__proto__`/`prototype`/`constructor` — see `shared/protoGuard.ts`.
    if (keys.some(isDangerousSegment)) return
    set((s) => {
      const root: Record<string, unknown> = { ...(s as unknown as Record<string, unknown>) }
      let cursor = root
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]
        const existing = cursor[key]
        // Build each intermediate as a prototype-less object (fresh, or a prototype-less
        // copy of the existing value) so writing into it can never reach Object.prototype,
        // even in the face of a future bug in the guard above.
        const next: Record<string, unknown> =
          existing !== null && typeof existing === 'object' && !Array.isArray(existing)
            ? Object.assign(Object.create(null), existing)
            : Object.create(null)
        cursor[key] = next
        cursor = next
      }
      cursor[keys[keys.length - 1]] = value
      return root as Partial<SettingsState>
    })
    scheduleSave(get)
  },
}))
