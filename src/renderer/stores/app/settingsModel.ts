import {
  type AssistModelSettings,
  DEFAULT_ASSIST_MODEL_SETTINGS,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { ExtensionSettingValues } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { AgentActTool } from '@shared/agent/agentCoreTools'
import { type AgentHostSettings, DEFAULT_AGENT_SETTINGS } from '@shared/agent/agentSettings'
import { type AgentHooks, DEFAULT_AGENT_HOOKS } from '@shared/agents/agentHooks'
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from '@shared/agents/managerSettings'
import {
  DEFAULT_PLAYBOOKS,
  type OwnPlaybook,
  type PlaybooksSettings,
} from '@shared/agents/playbooks'
import type { Locale } from '@shared/app/dict'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '@shared/app/notificationSettings'
import { DEFAULT_UPDATE_CHANNEL, type UpdateChannel } from '@shared/app/releases'
import { ZOOM_DEFAULT } from '@shared/app/zoom'
import { type ChatToolSettings, DEFAULT_CHAT_TOOL_SETTINGS } from '@shared/assist/chatTools'
import { DEFAULT_GIT_SETTINGS, type GitSettings } from '@shared/boards/git'
import { DEFAULT_PORTS_SETTINGS, type PortsSettings } from '@shared/boards/ports'
import type { ChordValue, KeybindingMap } from '@shared/keyboard/chordSpec'
import type { ModifierRemap } from '@shared/keyboard/modifierRemap'
import {
  type ApprovalMode,
  type ApprovalSettings,
  DEFAULT_APPROVAL_SETTINGS,
} from '@shared/permissions/approvals'
import type { ReachMode } from '@shared/permissions/reach'
import {
  DEFAULT_PRIVACY_SETTINGS,
  type PrivacySettings,
  type RedactionSettings,
} from '@shared/privacy/redaction'
import type { TelemetrySettings } from '@shared/privacy/telemetry'
import type { SyncKinds } from '@shared/profileSync/syncKinds'
import type { SandboxGlobals } from '@shared/sandbox/sandbox'
import { keyboardPlatform } from '@/lib/keyboard/keyboardPresets'
import type { TerminalKeyMap, TerminalSend } from '@/lib/keyboard/terminalKeys'
import type { UserAction } from '@/lib/settings/actions'
import {
  type BrowserSettings,
  DEFAULT_BROWSER_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
} from '@/lib/settings/browserEditorSettings'
import { DEFAULT_FILE_TREE_SETTINGS, type FileTreeSettings } from '@/lib/settings/fileTreeSettings'
import type {
  KeyboardElsewhere,
  KeyboardField,
  KeyboardFile,
} from '@/lib/settings/keyboardSettings'
import {
  DEFAULT_PANE_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  type PaneSettings,
  type TerminalSettings,
} from '@/lib/settings/terminalPaneSettings'
import { DEFAULT_WINDOW_TITLE } from '@/lib/settings/windowTitle'
import type { GroupRule } from '@/lib/sidebar/workspaceGroups'
import { isMac, platform } from '@/platform'

type ThemeId = string

export const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

export const isPlainObject = (v: unknown): v is Record<string, unknown> => kindOf(v) === 'object'

export interface SurfaceFont {
  family: string
  size: number
  weight: number
  baseSize?: number
}

interface TerminalFont extends SurfaceFont {
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

interface AgentSettings {
  hibernation: HibernationSettings
  autoResume: boolean
  trustWorkspaceFolders: boolean
  hooks: AgentHooks
}

interface AssistantSettings extends ChatToolSettings, AssistModelSettings {
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

export interface WorkspaceGroupSettings {
  byCwd: GroupRule[]
}

export const FONT_WEIGHTS: readonly number[] = [300, 400, 450, 500, 600, 700]

export type MotionMode = 'system' | 'reduced' | 'full'

export const MOTION_MODES: readonly MotionMode[] = ['system', 'reduced', 'full']

export const motionMode = (v: unknown): MotionMode =>
  MOTION_MODES.includes(v as MotionMode) ? (v as MotionMode) : 'system'

interface Appearance {
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

export type InputEscape = 'clear' | 'menus'

export const INPUT_ESCAPES: readonly InputEscape[] = ['clear', 'menus']

export const inputEscape = (v: unknown): InputEscape =>
  INPUT_ESCAPES.includes(v as InputEscape) ? (v as InputEscape) : 'clear'

export interface Behavior {
  cursorStyle: CursorStyle
  cursorBlink: boolean
  wheelSmoothScroll: boolean
  restoreWorkspace: boolean
  externalEditor: string
  gpuAcceleration: boolean
  copyOnSelect: boolean
  inputMode: InputMode
  inputEditorVim: boolean
  inputEscape: InputEscape
  liveFileSuggestions: boolean
  historySuggestions: boolean
  checkForUpdates: boolean
  updateChannel: UpdateChannel
  wheelZoom: boolean
  discreteGpu: boolean
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

export type FontSurface = 'ui' | 'terminal' | 'editor'

export interface Capabilities {
  grants?: Capability[]
  reach?: ReachMode
}

type SyncMethodChoice = 'folder' | 'server'

export interface SyncSettings {
  dir: string
  method?: 'server'
  kinds?: Partial<SyncKinds>
}

export interface Persisted {
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
  terminalKeymap: string | null
  keybindings: KeybindingMap
  terminalKeys: TerminalKeyMap
  modifierRemap: ModifierRemap
  keyboardElsewhere: KeyboardElsewhere
  agents: AgentSettings
  assistant: AssistantSettings
  agent: AgentHostSettings
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
  git: GitSettings
  ports: PortsSettings
  playbooks: PlaybooksSettings
}

export const DEFAULTS: Persisted = {
  locale: 'en',
  appearance: {
    theme: 'adeberry',
    followSystem: true,
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
    wheelSmoothScroll: false,
    restoreWorkspace: true,
    externalEditor: 'auto',
    gpuAcceleration: true,
    copyOnSelect: false,
    inputMode: 'terminal',
    inputEditorVim: false,
    inputEscape: 'clear',
    liveFileSuggestions: true,
    historySuggestions: true,
    checkForUpdates: true,
    updateChannel: DEFAULT_UPDATE_CHANNEL,
    wheelZoom: !isMac,
    discreteGpu: false,
  },
  files: DEFAULT_FILE_TREE_SETTINGS,
  terminal: DEFAULT_TERMINAL_SETTINGS,
  panes: DEFAULT_PANE_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  workspaces: DEFAULT_WORKSPACE_SETTINGS,
  browser: DEFAULT_BROWSER_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  keymap: null,
  terminalKeymap: null,
  keybindings: {},
  terminalKeys: {},
  modifierRemap: {},
  keyboardElsewhere: {},
  sidebar: {
    showPath: true,
    showMessage: true,
    showDescription: true,
    showExtensionItems: true,
    showSSH: true,
  },
  agents: {
    hibernation: DEFAULT_HIBERNATION,
    autoResume: false,
    trustWorkspaceFolders: false,
    hooks: DEFAULT_AGENT_HOOKS,
  },
  agent: DEFAULT_AGENT_SETTINGS,
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
  git: DEFAULT_GIT_SETTINGS,
  ports: DEFAULT_PORTS_SETTINGS,
  playbooks: DEFAULT_PLAYBOOKS,
}

export interface SettingsState extends Persisted {
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
  setGit: (patch: Partial<GitSettings>) => void
  setPorts: (patch: Partial<PortsSettings>) => void
  setPlaybookEnabled: (id: string, enabled: boolean) => void
  setPlaybookText: (id: string, text: string) => void
  resetPlaybook: (id: string) => void
  acceptPlaybook: (id: string) => void
  saveOwnPlaybook: (
    name: string,
    fields: Pick<OwnPlaybook, 'description' | 'text'>,
    replaces?: string,
  ) => void
  deleteOwnPlaybook: (name: string) => void
  setTerminal: (patch: Partial<TerminalSettings>) => void
  setPanes: (patch: Partial<PaneSettings>) => void
  setNotifications: (patch: Partial<NotificationSettings>) => void
  setTerminalLineHeight: (lineHeight: number) => void
  setSidebar: (patch: Partial<SidebarSettings>) => void
  setWorkspaces: (patch: Partial<WorkspaceSettings>) => void
  setSandbox: (next: SandboxGlobals) => Promise<void>
  setManager: (patch: Partial<ManagerSettings>) => void
  setRedaction: (patch: Partial<RedactionSettings>) => Promise<void>
  setTelemetry: (patch: Partial<TelemetrySettings>) => Promise<void>
  setBrowser: (patch: Partial<BrowserSettings>) => void
  setEditor: (patch: Partial<EditorSettings>) => void
  setAutoResume: (autoResume: boolean) => void
  setTrustWorkspaceFolders: (trustWorkspaceFolders: boolean) => void
  setAgentHooks: (patch: Partial<AgentHooks>) => void
  setAgentAlwaysAsk: (tool: AgentActTool, ask: boolean) => void
  setChatHistory: (chatHistory: boolean) => void
  setChatTools: (patch: Partial<ChatToolSettings>) => Promise<void>
  setAssistModels: (patch: Partial<AssistModelSettings>) => Promise<void>
  setHibernation: (patch: Partial<HibernationSettings>) => void
  previewSetting: (path: string, value: unknown) => SettingChange
  setByPath: (path: string, value: unknown) => SettingChange
  unsetByPath: (path: string) => SettingChange
  setSyncDir: (dir: string) => Promise<void>
  setSyncMethod: (method: SyncMethodChoice) => Promise<void>
  setSyncKinds: (kinds: SyncKinds) => Promise<void>
  setApprovalMode: (mode: ApprovalMode) => void
  setWindowTitle: (template: string) => void
  trustAction: (fingerprint: string) => void
  removeAction: (id: string) => void
  setKeymap: (ref: string | null) => void
  setKeybinding: (id: string, chord: ChordValue | null) => void
  resetKeybinding: (id: string) => void
  setKeybindings: (map: KeybindingMap) => void
  setTerminalKeymap: (id: string | null) => void
  setTerminalKey: (keys: string, send: TerminalSend | null) => void
  resetTerminalKey: (keys: string) => void
  setTerminalKeys: (map: TerminalKeyMap) => void
  setModifierRemap: (table: ModifierRemap) => void
  setExtensionSettings: (extId: string, values: ExtensionSettingValues) => void
}

export const HERE = keyboardPlatform(platform)

export type PersistedFile = Omit<Persisted, KeyboardField | 'keyboardElsewhere' | 'modifierRemap'> &
  KeyboardFile & { modifierRemap?: ModifierRemap }

export interface SettingChange {
  path: string
  previous: unknown
  value: unknown
  next: Partial<SettingsState>
}

export function pickBooleans<T extends object>(base: T, raw: unknown): T {
  const out = { ...base }
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(base) as (keyof T & string)[]) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as T[keyof T & string]
  }
  return out
}

export const FONT_SIZE_MIN = 8

export const FONT_SIZE_MAX = 32

export function withBaseSize(font: SurfaceFont): SurfaceFont {
  const { baseSize, ...rest } = font
  const valid =
    typeof baseSize === 'number' &&
    Number.isFinite(baseSize) &&
    baseSize >= FONT_SIZE_MIN &&
    baseSize <= FONT_SIZE_MAX &&
    baseSize !== font.size
  return valid ? { ...rest, baseSize } : rest
}

export const mergeFont = (base: SurfaceFont, p?: Partial<SurfaceFont>): SurfaceFont =>
  withBaseSize({ ...base, ...p })
