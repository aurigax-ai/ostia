import { type AgentHooks, DEFAULT_AGENT_HOOKS, parseAgentHooks } from '@shared/agentHooks'
import {
  type ApprovalMode,
  type ApprovalSettings,
  DEFAULT_APPROVAL_SETTINGS,
  parseApprovalSettings,
} from '@shared/approvals'
import { type KeybindingMap, parseKeybindings } from '@shared/chordSpec'
import { currentProductValue, currentThemeId } from '@shared/legacyIds'
import { debounce } from 'es-toolkit'
import { create } from 'zustand'
import {
  type AssistModelSettings,
  DEFAULT_ASSIST_MODEL_SETTINGS,
  parseAssistModelSettings,
} from '../../shared/assist'
import {
  type BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  parseBrowserSettings,
  parseEditorSettings,
} from '../../shared/browserEditorSettings'
import type { Capability } from '../../shared/capabilities'
import {
  type ChatToolSettings,
  DEFAULT_CHAT_TOOL_SETTINGS,
  parseChatToolSettings,
} from '../../shared/chatTools'
import type { ExtensionSettingValues } from '../../shared/extensions'
import { parseGlobalHotkey } from '../../shared/globalHotkey'
import {
  DEFAULT_MANAGER_SETTINGS,
  type ManagerSettings,
  parseManagerSettings,
} from '../../shared/managerSettings'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  parseNotificationSettings,
} from '../../shared/notificationSettings'
import { parsePromptSettings } from '../../shared/promptSettings'
import { isDangerousSegment } from '../../shared/protoGuard'
import {
  DEFAULT_PRIVACY_SETTINGS,
  type PrivacySettings,
  type RedactionSettings,
  parsePrivacySettings,
  parseRedactionSettings,
} from '../../shared/redaction'
import { type SandboxGlobals, parseSandboxGlobals } from '../../shared/sandbox'
import { normalizeGroupName } from '../../shared/workspaceGroups'
import { ZOOM_DEFAULT, clampZoom } from '../../shared/zoom'
import type { Locale } from '../i18n/dict'
import { normalizeHex } from '../lib/color'
import type { GroupRule } from '../lib/workspaceGroups'
import { type UserAction, parseActions } from '../settings/actions'
import {
  DEFAULT_FILE_TREE_SETTINGS,
  type FileTreeSettings,
  parseFileTreeSettings,
} from '../settings/fileTreeSettings'
import { parseKeymapSetting } from '../settings/keymapSetting'
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
import { DEFAULT_WINDOW_TITLE, parseWindowTitle } from '../settings/windowTitle'

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
  showSSH: boolean
}

export interface HibernationSettings {
  enabled: boolean
  idleSeconds: number
  maxLiveTerminals: number
}

export interface AgentSettings {
  hibernation: HibernationSettings
  autoResume: boolean
  hooks: AgentHooks
}

export interface AssistantSettings extends ChatToolSettings, AssistModelSettings {
  chatHistory: boolean
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
  windowTitle: string
}

export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: CursorStyle[] = ['block', 'underline', 'bar']

export type InputMode = 'terminal' | 'editor'

export const INPUT_MODES: readonly InputMode[] = ['terminal', 'editor']

export const inputMode = (v: unknown): InputMode =>
  INPUT_MODES.includes(v as InputMode) ? (v as InputMode) : 'terminal'

export interface Behavior {
  cursorStyle: CursorStyle
  cursorBlink: boolean
  restoreWorkspace: boolean
  externalEditor: string
  gpuAcceleration: boolean
  copyOnSelect: boolean
  inputMode: InputMode
  inputEditorVim: boolean
  historySuggestions: boolean
  checkForUpdates: boolean
  wheelZoom: boolean
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
  closeToTray: boolean
  wrapTitles: boolean
  globalHotkey: string
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  placement: 'end',
  inheritFolder: false,
  defaultFolder: '~',
  confirmClose: true,
  confirmQuit: true,
  closeToTray: true,
  wrapTitles: false,
  globalHotkey: '',
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
    globalHotkey: parseGlobalHotkey(raw.globalHotkey),
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
  files: FileTreeSettings
  terminal: TerminalSettings
  panes: PaneSettings
  notifications: NotificationSettings
  sidebar: SidebarSettings
  workspaces: WorkspaceSettings
  browser: BrowserSettings
  editor: EditorSettings
  keymap: string | null
  keybindings: KeybindingMap
  agents: AgentSettings
  assistant: AssistantSettings
  workspaceGroups: WorkspaceGroupSettings
  extensionSettings: Record<string, ExtensionSettingValues>
  capabilities?: Capabilities
  manager: ManagerSettings
  sync?: SyncSettings
  approvals: ApprovalSettings
  actions: UserAction[]
  trustedActions: string[]
  sandbox?: SandboxGlobals
  privacy: PrivacySettings
}

const DATA_KEYS: readonly string[] = [
  'locale',
  'appearance',
  'behavior',
  'files',
  'terminal',
  'panes',
  'notifications',
  'sidebar',
  'workspaces',
  'browser',
  'editor',
  'agents',
  'workspaceGroups',
  'actions',
]

const DEFAULTS: Persisted = {
  locale: 'en',
  appearance: {
    theme: 'adeberry',
    followSystem: false,
    lightTheme: 'ostia-light',
    darkTheme: 'adeberry',
    accent: '',
    zoom: ZOOM_DEFAULT,
    motion: 'system',
    ui: { family: 'Inter Variable', size: 13, weight: 400 },
    terminal: { family: 'Hack Nerd Font Mono', size: 13, weight: 400, lineHeight: 1.15 },
    editor: { family: 'Geist Mono Variable', size: 13, weight: 400 },
    windowTitle: DEFAULT_WINDOW_TITLE,
  },
  behavior: {
    cursorStyle: 'block',
    cursorBlink: true,
    restoreWorkspace: true,
    externalEditor: 'auto',
    gpuAcceleration: true,
    copyOnSelect: false,
    inputMode: 'terminal',
    inputEditorVim: false,
    historySuggestions: true,
    checkForUpdates: true,
    wheelZoom: true,
  },
  files: DEFAULT_FILE_TREE_SETTINGS,
  terminal: DEFAULT_TERMINAL_SETTINGS,
  panes: DEFAULT_PANE_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  workspaces: DEFAULT_WORKSPACE_SETTINGS,
  browser: DEFAULT_BROWSER_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  keymap: null,
  keybindings: {},
  sidebar: {
    showPath: true,
    showMessage: true,
    showDescription: true,
    showExtensionItems: true,
    showSSH: true,
  },
  agents: { hibernation: DEFAULT_HIBERNATION, autoResume: false, hooks: DEFAULT_AGENT_HOOKS },
  assistant: {
    chatHistory: true,
    ...DEFAULT_CHAT_TOOL_SETTINGS,
    ...DEFAULT_ASSIST_MODEL_SETTINGS,
  },
  workspaceGroups: { byCwd: [] },
  extensionSettings: {},
  approvals: DEFAULT_APPROVAL_SETTINGS,
  actions: [],
  trustedActions: [],
  manager: DEFAULT_MANAGER_SETTINGS,
  privacy: DEFAULT_PRIVACY_SETTINGS,
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
  setFiles: (patch: Partial<FileTreeSettings>) => void
  setTerminal: (patch: Partial<TerminalSettings>) => void
  setPanes: (patch: Partial<PaneSettings>) => void
  setNotifications: (patch: Partial<NotificationSettings>) => void
  setTerminalLineHeight: (lineHeight: number) => void
  setSidebar: (patch: Partial<SidebarSettings>) => void
  setWorkspaces: (patch: Partial<WorkspaceSettings>) => void
  setSandbox: (next: SandboxGlobals) => Promise<void>
  setManager: (patch: Partial<ManagerSettings>) => void
  setRedaction: (patch: Partial<RedactionSettings>) => Promise<void>
  setBrowser: (patch: Partial<BrowserSettings>) => void
  setEditor: (patch: Partial<EditorSettings>) => void
  setAutoResume: (autoResume: boolean) => void
  setAgentHooks: (patch: Partial<AgentHooks>) => void
  setChatHistory: (chatHistory: boolean) => void
  setChatTools: (patch: Partial<ChatToolSettings>) => Promise<void>
  setAssistModels: (patch: Partial<AssistModelSettings>) => Promise<void>
  setHibernation: (patch: Partial<HibernationSettings>) => void
  previewSetting: (path: string, value: unknown) => SettingChange
  setByPath: (path: string, value: unknown) => SettingChange
  unsetByPath: (path: string) => SettingChange
  setSyncDir: (dir: string) => Promise<void>
  setApprovalMode: (mode: ApprovalMode) => void
  setWindowTitle: (template: string) => void
  trustAction: (fingerprint: string) => void
  removeAction: (id: string) => void
  setKeymap: (ref: string | null) => void
  setKeybinding: (id: string, chord: string | null) => void
  resetKeybinding: (id: string) => void
  setKeybindings: (map: KeybindingMap) => void
  setExtensionSettings: (extId: string, values: ExtensionSettingValues) => void
}

function parseBehavior(raw: unknown): Behavior {
  const src = isPlainObject(raw) ? raw : {}
  const base = pickBooleans(DEFAULTS.behavior, src)
  return {
    ...base,
    cursorStyle: CURSOR_STYLES.includes(src.cursorStyle as CursorStyle)
      ? (src.cursorStyle as CursorStyle)
      : DEFAULTS.behavior.cursorStyle,
    externalEditor:
      typeof src.externalEditor === 'string'
        ? src.externalEditor
        : DEFAULTS.behavior.externalEditor,
    inputMode: inputMode(src.inputMode),
  }
}

export function parsePersisted(p: Partial<Persisted>): Persisted {
  return {
    locale: p.locale ?? DEFAULTS.locale,
    appearance: {
      theme: currentThemeId(p.appearance?.theme ?? DEFAULTS.appearance.theme),
      followSystem: p.appearance?.followSystem === true,
      lightTheme: currentThemeId(p.appearance?.lightTheme ?? DEFAULTS.appearance.lightTheme),
      darkTheme: currentThemeId(p.appearance?.darkTheme ?? DEFAULTS.appearance.darkTheme),
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
      windowTitle: parseWindowTitle(p.appearance?.windowTitle),
    },
    behavior: parseBehavior(p.behavior),
    files: parseFileTreeSettings(p.files),
    terminal: parseTerminalSettings(p.terminal),
    panes: parsePaneSettings(p.panes),
    notifications: parseNotificationSettings(p.notifications),
    sidebar: pickBooleans(DEFAULTS.sidebar, p.sidebar),
    workspaces: parseWorkspaceSettings(p.workspaces),
    browser: parseBrowserSettings(p.browser),
    editor: parseEditorSettings(p.editor),
    keymap: parseKeymapSetting(p.keymap),
    keybindings: parseKeybindings(p.keybindings),
    agents: {
      hibernation: parseHibernation(p.agents?.hibernation),
      autoResume: p.agents?.autoResume === true,
      hooks: parseAgentHooks(p.agents?.hooks),
    },
    assistant: {
      chatHistory: p.assistant?.chatHistory !== false,
      ...parseChatToolSettings(p.assistant),
      ...parseAssistModelSettings(p.assistant),
    },
    workspaceGroups: parseWorkspaceGroupSettings(p.workspaceGroups),
    extensionSettings: extensionSettingsOf(p.extensionSettings),
    capabilities: isPlainObject(p.capabilities) ? p.capabilities : undefined,
    manager: parseManagerSettings(p.manager),
    sync: syncOf(p.sync),
    approvals: parseApprovalSettings(p.approvals),
    actions: parseActions(p.actions),
    trustedActions: Array.isArray(p.trustedActions)
      ? p.trustedActions.filter((f): f is string => typeof f === 'string')
      : [],
    sandbox: p.sandbox === undefined ? undefined : parseSandboxGlobals(p.sandbox),
    privacy: parsePrivacySettings(p.privacy),
  }
}

export interface SettingChange {
  path: string
  previous: unknown
  value: unknown
  next: Partial<SettingsState>
}

export function getByPath(root: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, key) => (isPlainObject(acc) && key in acc ? acc[key] : undefined), root)
}

function survives(wanted: unknown, parsed: unknown): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(parsed) &&
      parsed.length === wanted.length &&
      wanted.every((item, i) => survives(item, parsed[i]))
    )
  }
  if (isPlainObject(wanted)) {
    return isPlainObject(parsed) && Object.keys(wanted).every((k) => survives(wanted[k], parsed[k]))
  }
  return JSON.stringify(wanted) === JSON.stringify(parsed)
}

function dataRoot(s: Persisted): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null)
  for (const key of DATA_KEYS) root[key] = s[key as keyof Persisted]
  return root
}

function applySetting(s: SettingsState, path: string, value: unknown): SettingChange {
  const keys = path.split('.').filter(Boolean)
  if (keys.length === 0) throw new Error('settings path is empty')
  if (keys.some(isDangerousSegment)) throw new Error(`invalid settings path: ${path}`)
  if (!DATA_KEYS.includes(keys[0])) {
    throw new Error(`unknown settings key: ${keys[0]} (expected one of ${DATA_KEYS.join(', ')})`)
  }
  if (value === undefined) throw new Error(`cannot set ${path}: value is undefined`)
  const root = dataRoot(s)
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
  const previous = cursor[leaf]
  if (previous === undefined) throw new Error(`unknown settings key: ${path}`)
  if (kindOf(previous) !== kindOf(value)) {
    throw new Error(`cannot set ${path}: expected ${kindOf(previous)}, got ${kindOf(value)}`)
  }
  cursor[leaf] = value
  const parsed = parsePersisted({ ...s, ...(root as Partial<Persisted>) })
  const stored = getByPath(parsed, path)
  const renamed =
    typeof value === 'string' ? currentThemeId(currentProductValue(value) as string) : value
  if (!survives(value, stored) && !survives(renamed, stored)) {
    throw new Error(`invalid value for ${path}: ${JSON.stringify(value)}`)
  }
  const next = dataRoot(parsed) as Partial<SettingsState>
  return { path, previous, value: getByPath(parsed, path), next }
}

async function writeSettings(s: SettingsState): Promise<void> {
  const snapshot: Persisted = {
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
    agents: s.agents,
    assistant: s.assistant,
    workspaceGroups: s.workspaceGroups,
    extensionSettings: s.extensionSettings,
    capabilities: s.capabilities,
    manager: s.manager,
    sync: s.sync,
    approvals: s.approvals,
    actions: s.actions,
    trustedActions: s.trustedActions,
    sandbox: s.sandbox,
    privacy: s.privacy,
  }
  const path = await window.pine.settings.path()
  await window.pine.fs.write(path, `${JSON.stringify(snapshot, null, 2)}\n`)
}

const scheduleSave = debounce((get: () => SettingsState): void => {
  writeSettings(get()).catch((err: unknown) => console.error('[settings] save failed', err))
}, 300)

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
      set(parsePersisted(JSON.parse(raw) as Partial<Persisted>))
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
  setFiles: (patch) => {
    set((s) => ({ files: parseFileTreeSettings({ ...s.files, ...patch }) }))
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
        prompt: parsePromptSettings(patch.prompt ?? s.terminal.prompt),
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
  setSandbox: async (next) => {
    set({ sandbox: next })
    await writeSettings(get())
    await window.pine.sandbox.globalsChanged()
  },
  setManager: (patch) => {
    set((s) => ({ manager: parseManagerSettings({ ...s.manager, ...patch }) }))
    scheduleSave(get)
  },
  setRedaction: async (patch) => {
    set((s) => ({
      privacy: { redaction: parseRedactionSettings({ ...s.privacy.redaction, ...patch }) },
    }))
    scheduleSave.cancel()
    await writeSettings(get())
  },
  setBrowser: (patch) => {
    set((s) => ({ browser: parseBrowserSettings({ ...s.browser, ...patch }) }))
    scheduleSave(get)
  },
  setEditor: (patch) => {
    set((s) => ({ editor: parseEditorSettings({ ...s.editor, ...patch }) }))
    scheduleSave(get)
  },
  setKeymap: (ref) => {
    set({ keymap: parseKeymapSetting(ref) })
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
  setChatHistory: (chatHistory) => {
    set((s) => ({ assistant: { ...s.assistant, chatHistory } }))
    scheduleSave(get)
  },
  setChatTools: async (patch) => {
    set((s) => ({
      assistant: { ...s.assistant, ...parseChatToolSettings({ ...s.assistant, ...patch }) },
    }))
    scheduleSave.cancel()
    await writeSettings(get())
  },
  setAssistModels: async (patch) => {
    set((s) => ({
      assistant: { ...s.assistant, ...parseAssistModelSettings({ ...s.assistant, ...patch }) },
    }))
    scheduleSave.cancel()
    await writeSettings(get())
  },
  setAutoResume: (autoResume) => {
    set((s) => ({ agents: { ...s.agents, autoResume } }))
    scheduleSave(get)
  },
  setAgentHooks: (patch) => {
    set((s) => ({ agents: { ...s.agents, hooks: { ...s.agents.hooks, ...patch } } }))
    scheduleSave(get)
  },
  setHibernation: (patch) => {
    set((s) => ({
      agents: { ...s.agents, hibernation: parseHibernation({ ...s.agents.hibernation, ...patch }) },
    }))
    scheduleSave(get)
  },
  trustAction: (fingerprint) => {
    set((s) =>
      s.trustedActions.includes(fingerprint)
        ? s
        : { trustedActions: [...s.trustedActions, fingerprint] },
    )
    scheduleSave(get)
  },
  removeAction: (id) => {
    set((s) => ({ actions: s.actions.filter((a) => a.id !== id) }))
    scheduleSave(get)
  },
  setWindowTitle: (windowTitle) => {
    set((s) => ({ appearance: { ...s.appearance, windowTitle: parseWindowTitle(windowTitle) } }))
    scheduleSave(get)
  },
  setApprovalMode: (mode) => {
    set({ approvals: { mode } })
    scheduleSave(get)
  },
  setSyncDir: async (dir) => {
    scheduleSave.cancel()
    set({ sync: dir ? { dir } : undefined })
    await writeSettings(get())
  },
  previewSetting: (path, value) => applySetting(get(), path, value),
  setByPath: (path, value) => {
    const change = applySetting(get(), path, value)
    set(change.next)
    scheduleSave(get)
    return change
  },
  unsetByPath: (path) => {
    const fallback = getByPath(DEFAULTS, path)
    if (fallback === undefined) throw new Error(`unknown settings key: ${path}`)
    return get().setByPath(path, structuredClone(fallback))
  },
}))
