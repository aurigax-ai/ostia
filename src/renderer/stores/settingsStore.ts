import { create } from 'zustand'
import type { Capability } from '../../shared/capabilities'
import { isDangerousSegment } from '../../shared/protoGuard'
import type { Locale } from '../i18n/dict'

export type ThemeId = string

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

export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: CursorStyle[] = ['block', 'underline', 'bar']

export interface Behavior {
  showHiddenFiles: boolean
  cursorStyle: CursorStyle
  cursorBlink: boolean
  restoreSession: boolean
}

export type FontSurface = 'ui' | 'terminal' | 'editor'

export interface Capabilities {
  grants?: Capability[]
}

interface Persisted {
  locale: Locale
  appearance: Appearance
  behavior: Behavior
  capabilities?: Capabilities
}

const DATA_KEYS: readonly string[] = ['locale', 'appearance', 'behavior']

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

const isPlainObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object'

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
  init: () => Promise<void>
  setLocale: (l: Locale) => void
  setTheme: (t: ThemeId) => void
  setSurfaceFont: (surface: FontSurface, patch: Partial<SurfaceFont>) => void
  setBehavior: (patch: Partial<Behavior>) => void
  setByPath: (path: string, value: unknown) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(get: () => SettingsState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const s = get()
    const snapshot: Persisted = {
      locale: s.locale,
      appearance: s.appearance,
      behavior: s.behavior,
      capabilities: s.capabilities,
    }
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
        capabilities: isPlainObject(p.capabilities) ? p.capabilities : undefined,
      })
    } catch {}
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
    if (keys.length === 0) throw new Error('settings path is empty')
    if (keys.some(isDangerousSegment)) throw new Error(`invalid settings path: ${path}`)
    if (!DATA_KEYS.includes(keys[0])) {
      throw new Error(`unknown settings key: ${keys[0]} (expected one of ${DATA_KEYS.join(', ')})`)
    }
    if (value === undefined) throw new Error(`cannot set ${path}: value is undefined`)
    const s = get()
    const root: Record<string, unknown> = Object.assign(Object.create(null), {
      locale: s.locale,
      appearance: s.appearance,
      behavior: s.behavior,
      capabilities: s.capabilities,
    })
    let cursor = root
    for (let i = 0; i < keys.length - 1; i++) {
      const existing = cursor[keys[i]]
      if (existing !== undefined && !isPlainObject(existing)) {
        const at = keys.slice(0, i + 1).join('.')
        throw new Error(`cannot set ${path}: ${at} is ${kindOf(existing)}, not an object`)
      }
      const next: Record<string, unknown> = Object.assign(Object.create(null), existing)
      cursor[keys[i]] = next
      cursor = next
    }
    const leaf = keys[keys.length - 1]
    const existing = cursor[leaf]
    if (existing !== undefined && kindOf(existing) !== kindOf(value)) {
      throw new Error(`cannot set ${path}: expected ${kindOf(existing)}, got ${kindOf(value)}`)
    }
    cursor[leaf] = value
    set(root as Partial<SettingsState>)
    scheduleSave(get)
  },
}))
