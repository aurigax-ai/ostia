import { create } from 'zustand'
import type { Capability } from '../../shared/capabilities'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from '../../shared/notificationSettings'
import { isDangerousSegment } from '../../shared/protoGuard'
import type { Locale } from '../i18n/dict'
import {
  DEFAULT_PANE_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  type PaneSettings,
  type TerminalSettings,
  clampContrast,
  clampScrollSpeed,
  clampScrollback,
  parsePaneSettings,
  parseTerminalSettings,
} from '../settings/terminalPaneSettings'

export type ThemeId = string

export interface SurfaceFont {
  family: string
  size: number
  weight: number
}

export interface TerminalFont extends SurfaceFont {
  lineHeight: number
}

export const LINE_HEIGHT_MIN = 1
export const LINE_HEIGHT_MAX = 2

export const clampLineHeight = (n: number): number =>
  Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, Math.round(n * 100) / 100))

export interface SidebarSettings {
  showPath: boolean
  showMessage: boolean
  showDescription: boolean
  showExtensionItems: boolean
}

export const FONT_WEIGHTS: readonly number[] = [300, 400, 450, 500, 600, 700]

export type MotionMode = 'system' | 'reduced' | 'full'

export const MOTION_MODES: readonly MotionMode[] = ['system', 'reduced', 'full']

export const motionMode = (v: unknown): MotionMode =>
  MOTION_MODES.includes(v as MotionMode) ? (v as MotionMode) : 'system'

export interface Appearance {
  theme: ThemeId
  motion: MotionMode
  ui: SurfaceFont
  terminal: TerminalFont
  editor: SurfaceFont
}

export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: CursorStyle[] = ['block', 'underline', 'bar']

export type InputMode = 'terminal' | 'editor'

export const INPUT_MODES: readonly InputMode[] = ['terminal', 'editor']

export const inputMode = (v: unknown): InputMode =>
  INPUT_MODES.includes(v as InputMode) ? (v as InputMode) : 'terminal'

export interface Behavior {
  showHiddenFiles: boolean
  cursorStyle: CursorStyle
  cursorBlink: boolean
  restoreWorkspace: boolean
  externalEditor: string
  gpuAcceleration: boolean
  copyOnSelect: boolean
  inputMode: InputMode
}

export type FontSurface = 'ui' | 'terminal' | 'editor'

export interface Capabilities {
  grants?: Capability[]
}

export interface SyncSettings {
  dir: string
}

interface Persisted {
  locale: Locale
  appearance: Appearance
  behavior: Behavior
  terminal: TerminalSettings
  panes: PaneSettings
  notifications: NotificationSettings
  sidebar: SidebarSettings
  capabilities?: Capabilities
  sync?: SyncSettings
}

const DATA_KEYS: readonly string[] = [
  'locale',
  'appearance',
  'behavior',
  'terminal',
  'panes',
  'notifications',
  'sidebar',
]

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

const isPlainObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object'

const DEFAULTS: Persisted = {
  locale: 'en',
  appearance: {
    theme: 'adeberry',
    motion: 'system',
    ui: { family: 'Inter Variable', size: 13, weight: 450 },
    terminal: { family: 'Hack Nerd Font Mono', size: 13, weight: 500, lineHeight: 1.15 },
    editor: { family: 'Geist Mono Variable', size: 13, weight: 450 },
  },
  behavior: {
    showHiddenFiles: true,
    cursorStyle: 'block',
    cursorBlink: true,
    restoreWorkspace: true,
    externalEditor: 'auto',
    gpuAcceleration: true,
    copyOnSelect: false,
    inputMode: 'terminal',
  },
  terminal: DEFAULT_TERMINAL_SETTINGS,
  panes: DEFAULT_PANE_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  sidebar: { showPath: true, showMessage: true, showDescription: true, showExtensionItems: true },
}

interface SettingsState extends Persisted {
  init: () => Promise<void>
  setLocale: (l: Locale) => void
  setTheme: (t: ThemeId) => void
  setMotion: (m: MotionMode) => void
  setSurfaceFont: (surface: FontSurface, patch: Partial<SurfaceFont>) => void
  setBehavior: (patch: Partial<Behavior>) => void
  setTerminal: (patch: Partial<TerminalSettings>) => void
  setPanes: (patch: Partial<PaneSettings>) => void
  setNotifications: (patch: Partial<NotificationSettings>) => void
  setTerminalLineHeight: (lineHeight: number) => void
  setSidebar: (patch: Partial<SidebarSettings>) => void
  setByPath: (path: string, value: unknown) => void
  setSyncDir: (dir: string) => Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

async function writeSettings(s: SettingsState): Promise<void> {
  const snapshot: Persisted = {
    locale: s.locale,
    appearance: s.appearance,
    behavior: s.behavior,
    terminal: s.terminal,
    panes: s.panes,
    notifications: s.notifications,
    sidebar: s.sidebar,
    capabilities: s.capabilities,
    sync: s.sync,
  }
  const path = await window.pine.settings.path()
  await window.pine.fs.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
}

function scheduleSave(get: () => SettingsState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void writeSettings(get()), 300)
}

const syncOf = (v: unknown): SyncSettings | undefined =>
  isPlainObject(v) && typeof v.dir === 'string' ? { dir: v.dir } : undefined

function pickBooleans<T extends object>(base: T, raw: unknown): T {
  const out = { ...base }
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as T[keyof T & string]
  }
  return out
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
          motion: motionMode(p.appearance?.motion),
          ui: mergeFont(DEFAULTS.appearance.ui, p.appearance?.ui),
          terminal: {
            ...mergeFont(DEFAULTS.appearance.terminal, p.appearance?.terminal),
            lineHeight: clampLineHeight(
              Number(p.appearance?.terminal?.lineHeight ?? DEFAULTS.appearance.terminal.lineHeight),
            ),
          },
          editor: mergeFont(DEFAULTS.appearance.editor, p.appearance?.editor),
        },
        behavior: {
          ...DEFAULTS.behavior,
          ...p.behavior,
          inputMode: inputMode(p.behavior?.inputMode),
        },
        terminal: parseTerminalSettings(p.terminal),
        panes: parsePaneSettings(p.panes),
        notifications: parseNotificationSettings(p.notifications),
        sidebar: pickBooleans(DEFAULTS.sidebar, p.sidebar),
        capabilities: isPlainObject(p.capabilities) ? p.capabilities : undefined,
        sync: syncOf(p.sync),
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
  setMotion: (motion) => {
    set((s) => ({ appearance: { ...s.appearance, motion } }))
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
  setTerminal: (patch) => {
    set((s) => ({
      terminal: {
        ...s.terminal,
        ...patch,
        scrollSpeed: clampScrollSpeed(patch.scrollSpeed ?? s.terminal.scrollSpeed),
        scrollbackLines: clampScrollback(patch.scrollbackLines ?? s.terminal.scrollbackLines),
        minimumContrast: clampContrast(patch.minimumContrast ?? s.terminal.minimumContrast),
      },
    }))
    scheduleSave(get)
  },
  setPanes: (patch) => {
    set((s) => ({ panes: { ...s.panes, ...patch } }))
    scheduleSave(get)
  },
  setNotifications: (patch) => {
    set((s) => ({ notifications: { ...s.notifications, ...patch } }))
    scheduleSave(get)
  },
  setTerminalLineHeight: (lineHeight) => {
    set((s) => ({
      appearance: {
        ...s.appearance,
        terminal: { ...s.appearance.terminal, lineHeight: clampLineHeight(lineHeight) },
      },
    }))
    scheduleSave(get)
  },
  setSidebar: (patch) => {
    set((s) => ({ sidebar: { ...s.sidebar, ...patch } }))
    scheduleSave(get)
  },
  setSyncDir: async (dir) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    set({ sync: dir ? { dir } : undefined })
    await writeSettings(get())
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
      terminal: s.terminal,
      panes: s.panes,
      notifications: s.notifications,
      sidebar: s.sidebar,
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
    root.terminal = parseTerminalSettings(root.terminal)
    root.panes = parsePaneSettings(root.panes)
    set(root as Partial<SettingsState>)
    scheduleSave(get)
  },
}))
