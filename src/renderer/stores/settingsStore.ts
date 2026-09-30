import { create } from 'zustand'
import {
  type BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  parseBrowserSettings,
  parseEditorSettings,
} from '../../shared/browserEditorSettings'
import type { Capability } from '../../shared/capabilities'
import type { ExtensionSettingValues } from '../../shared/extensions'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from '../../shared/notificationSettings'
import { isDangerousSegment } from '../../shared/protoGuard'
import { normalizeGroupName } from '../../shared/workspaceGroups'
import { ZOOM_DEFAULT, clampZoom } from '../../shared/zoom'
import type { Locale } from '../i18n/dict'
import { type KeybindingMap, parseKeybindings } from '../lib/chordSpec'
import { normalizeHex } from '../lib/color'
import type { GroupRule } from '../lib/workspaceGroups'
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

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

const isPlainObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object'

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
  showPorts: boolean
  showSSH: boolean
}

export interface HibernationSettings {
  enabled: boolean
  idleSeconds: number
  maxLiveTerminals: number
}

export interface AgentSettings {
  hibernation: HibernationSettings
}

export const HIBERNATION_IDLE_MIN = 5
export const HIBERNATION_IDLE_MAX = 86_400
export const HIBERNATION_LIVE_MAX = 64

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export const clampIdleSeconds = (v: unknown): number =>
  clampInt(v, HIBERNATION_IDLE_MIN, HIBERNATION_IDLE_MAX, DEFAULT_HIBERNATION.idleSeconds)

export const clampMaxLive = (v: unknown): number =>
  clampInt(v, 0, HIBERNATION_LIVE_MAX, DEFAULT_HIBERNATION.maxLiveTerminals)

export const DEFAULT_HIBERNATION: HibernationSettings = {
  enabled: false,
  idleSeconds: 600,
  maxLiveTerminals: 6,
}

function parseHibernation(raw: unknown): HibernationSettings {
  if (!isPlainObject(raw)) return DEFAULT_HIBERNATION
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_HIBERNATION.enabled,
    idleSeconds: clampIdleSeconds(raw.idleSeconds ?? DEFAULT_HIBERNATION.idleSeconds),
    maxLiveTerminals: clampMaxLive(raw.maxLiveTerminals ?? DEFAULT_HIBERNATION.maxLiveTerminals),
  }
}

export interface WorkspaceGroupSettings {
  byCwd: GroupRule[]
}

const MAX_GROUP_RULES = 50

export function parseWorkspaceGroupSettings(raw: unknown): WorkspaceGroupSettings {
  const list = isPlainObject(raw) && Array.isArray(raw.byCwd) ? raw.byCwd : []
  const byCwd: GroupRule[] = []
  for (const entry of list) {
    if (byCwd.length >= MAX_GROUP_RULES) break
    if (!isPlainObject(entry) || typeof entry.pattern !== 'string') continue
    const pattern = entry.pattern.trim()
    const group = normalizeGroupName(entry.group)
    if (pattern && group) byCwd.push({ pattern, group })
  }
  return { byCwd }
}

export const FONT_WEIGHTS: readonly number[] = [300, 400, 450, 500, 600, 700]

export type MotionMode = 'system' | 'reduced' | 'full'

export const MOTION_MODES: readonly MotionMode[] = ['system', 'reduced', 'full']

export const motionMode = (v: unknown): MotionMode =>
  MOTION_MODES.includes(v as MotionMode) ? (v as MotionMode) : 'system'

export interface Appearance {
  theme: ThemeId
  followSystem: boolean
  lightTheme: ThemeId
  darkTheme: ThemeId
  accent: string
  zoom: number
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
  inputEditorVim: boolean
}

export type NewWorkspacePlacement = 'end' | 'top' | 'afterCurrent'

export const NEW_WORKSPACE_PLACEMENTS: readonly NewWorkspacePlacement[] = [
  'end',
  'top',
  'afterCurrent',
]

export interface WorkspaceSettings {
  placement: NewWorkspacePlacement
  inheritFolder: boolean
  defaultFolder: string
  confirmClose: boolean
  confirmQuit: boolean
  wrapTitles: boolean
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  placement: 'end',
  inheritFolder: false,
  defaultFolder: '~',
  confirmClose: true,
  confirmQuit: true,
  wrapTitles: false,
}

export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const base = DEFAULT_WORKSPACE_SETTINGS
  if (!isPlainObject(raw)) return base
  const folder = typeof raw.defaultFolder === 'string' ? raw.defaultFolder.trim() : ''
  return {
    ...pickBooleans(base, raw),
    placement: NEW_WORKSPACE_PLACEMENTS.includes(raw.placement as NewWorkspacePlacement)
      ? (raw.placement as NewWorkspacePlacement)
      : base.placement,
    defaultFolder: folder || base.defaultFolder,
  }
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
  workspaces: WorkspaceSettings
  browser: BrowserSettings
  editor: EditorSettings
  keybindings: KeybindingMap
  agents: AgentSettings
  workspaceGroups: WorkspaceGroupSettings
  extensionSettings: Record<string, ExtensionSettingValues>
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
  'workspaces',
  'browser',
  'editor',
  'agents',
  'workspaceGroups',
]

const DEFAULTS: Persisted = {
  locale: 'en',
  appearance: {
    theme: 'adeberry',
    followSystem: false,
    lightTheme: 'pine-light',
    darkTheme: 'adeberry',
    accent: '',
    zoom: ZOOM_DEFAULT,
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
    inputEditorVim: false,
  },
  terminal: DEFAULT_TERMINAL_SETTINGS,
  panes: DEFAULT_PANE_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  workspaces: DEFAULT_WORKSPACE_SETTINGS,
  browser: DEFAULT_BROWSER_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  keybindings: {},
  sidebar: {
    showPath: true,
    showMessage: true,
    showDescription: true,
    showExtensionItems: true,
    showPorts: true,
    showSSH: true,
  },
  agents: { hibernation: DEFAULT_HIBERNATION },
  workspaceGroups: { byCwd: [] },
  extensionSettings: {},
}

interface SettingsState extends Persisted {
  init: () => Promise<void>
  setLocale: (l: Locale) => void
  setTheme: (t: ThemeId) => void
  setFollowSystem: (on: boolean) => void
  setLightTheme: (t: ThemeId) => void
  setDarkTheme: (t: ThemeId) => void
  setAccent: (hex: string) => boolean
  setZoom: (percent: number) => void
  setMotion: (m: MotionMode) => void
  setSurfaceFont: (surface: FontSurface, patch: Partial<SurfaceFont>) => void
  setBehavior: (patch: Partial<Behavior>) => void
  setTerminal: (patch: Partial<TerminalSettings>) => void
  setPanes: (patch: Partial<PaneSettings>) => void
  setNotifications: (patch: Partial<NotificationSettings>) => void
  setTerminalLineHeight: (lineHeight: number) => void
  setSidebar: (patch: Partial<SidebarSettings>) => void
  setWorkspaces: (patch: Partial<WorkspaceSettings>) => void
  setBrowser: (patch: Partial<BrowserSettings>) => void
  setEditor: (patch: Partial<EditorSettings>) => void
  setHibernation: (patch: Partial<HibernationSettings>) => void
  setByPath: (path: string, value: unknown) => void
  setSyncDir: (dir: string) => Promise<void>
  setKeybinding: (id: string, chord: string | null) => void
  resetKeybinding: (id: string) => void
  setKeybindings: (map: KeybindingMap) => void
  setExtensionSettings: (extId: string, values: ExtensionSettingValues) => void
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
    workspaces: s.workspaces,
    browser: s.browser,
    editor: s.editor,
    keybindings: s.keybindings,
    agents: s.agents,
    workspaceGroups: s.workspaceGroups,
    extensionSettings: s.extensionSettings,
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

const extensionSettingsOf = (v: unknown): Record<string, ExtensionSettingValues> => {
  if (!isPlainObject(v)) return {}
  const out: Record<string, ExtensionSettingValues> = {}
  for (const [extId, values] of Object.entries(v)) {
    if (!isDangerousSegment(extId) && isPlainObject(values)) {
      out[extId] = values as ExtensionSettingValues
    }
  }
  return out
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
          followSystem: p.appearance?.followSystem === true,
          lightTheme: p.appearance?.lightTheme ?? DEFAULTS.appearance.lightTheme,
          darkTheme: p.appearance?.darkTheme ?? DEFAULTS.appearance.darkTheme,
          accent: normalizeHex(p.appearance?.accent) ?? '',
          zoom: clampZoom(p.appearance?.zoom),
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
          inputEditorVim: p.behavior?.inputEditorVim === true,
        },
        terminal: parseTerminalSettings(p.terminal),
        panes: parsePaneSettings(p.panes),
        notifications: parseNotificationSettings(p.notifications),
        sidebar: pickBooleans(DEFAULTS.sidebar, p.sidebar),
        workspaces: parseWorkspaceSettings(p.workspaces),
        browser: parseBrowserSettings(p.browser),
        editor: parseEditorSettings(p.editor),
        keybindings: parseKeybindings(p.keybindings),
        agents: { hibernation: parseHibernation(p.agents?.hibernation) },
        workspaceGroups: parseWorkspaceGroupSettings(p.workspaceGroups),
        extensionSettings: extensionSettingsOf(p.extensionSettings),
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
  setFollowSystem: (followSystem) => {
    set((s) => ({ appearance: { ...s.appearance, followSystem } }))
    scheduleSave(get)
  },
  setLightTheme: (lightTheme) => {
    set((s) => ({ appearance: { ...s.appearance, lightTheme } }))
    scheduleSave(get)
  },
  setDarkTheme: (darkTheme) => {
    set((s) => ({ appearance: { ...s.appearance, darkTheme } }))
    scheduleSave(get)
  },
  setAccent: (hex) => {
    const accent = hex.trim() === '' ? '' : normalizeHex(hex)
    if (accent === null) return false
    set((s) => ({ appearance: { ...s.appearance, accent } }))
    scheduleSave(get)
    return true
  },
  setZoom: (percent) => {
    set((s) => ({ appearance: { ...s.appearance, zoom: clampZoom(percent) } }))
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
  setWorkspaces: (patch) => {
    set((s) => ({ workspaces: { ...s.workspaces, ...patch } }))
    scheduleSave(get)
  },
  setBrowser: (patch) => {
    set((s) => ({ browser: parseBrowserSettings({ ...s.browser, ...patch }) }))
    scheduleSave(get)
  },
  setEditor: (patch) => {
    set((s) => ({ editor: parseEditorSettings({ ...s.editor, ...patch }) }))
    scheduleSave(get)
  },
  setKeybinding: (id, chord) => {
    set((s) => ({ keybindings: { ...s.keybindings, [id]: chord } }))
    scheduleSave(get)
  },
  resetKeybinding: (id) => {
    set((s) => {
      const { [id]: _removed, ...rest } = s.keybindings
      return { keybindings: rest }
    })
    scheduleSave(get)
  },
  setKeybindings: (keybindings) => {
    set({ keybindings })
    scheduleSave(get)
  },
  setExtensionSettings: (extId, values) => {
    set((s) => ({ extensionSettings: { ...s.extensionSettings, [extId]: values } }))
    scheduleSave(get)
  },
  setHibernation: (patch) => {
    set((s) => ({
      agents: { ...s.agents, hibernation: parseHibernation({ ...s.agents.hibernation, ...patch }) },
    }))
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
      workspaces: s.workspaces,
      browser: s.browser,
      editor: s.editor,
      agents: s.agents,
      workspaceGroups: s.workspaceGroups,
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
    root.workspaceGroups = parseWorkspaceGroupSettings(root.workspaceGroups)
    set(root as Partial<SettingsState>)
    scheduleSave(get)
  },
}))
