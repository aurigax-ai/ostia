import type {
  AgentHookContribution,
  AgentHookSummary,
  AgentSkillContribution,
} from './agentPlugins'
import type { AssistPoint } from './assist'
import type { Capability } from './capabilities'
import type { EditorLanguageContribution } from './editorLanguages'
import type { ExtensionConnectionKind } from './extensionConnections'
import type { FileKindContribution, FileKindInfo } from './fileKinds'
import type { IconThemeContribution, IconThemeInfo } from './iconTheme'
import { isRecord } from './isRecord'
import type { KeymapContribution, KeymapInfo } from './keymap'
import type { LanguageContribution, LanguageInfo } from './languagePack'
import type { LanguageServerContribution, LanguageServerSummary } from './languageServers'
import type { RemoteCwd } from './remoteFolders'
import type { Snippet } from './snippets'

export const EXTENSION_MANIFEST_FILE = 'ostia.json'

export const EXTENSION_ICONS = [
  'puzzle',
  'kanban',
  'book-open',
  'git-branch',
  'globe',
  'bell',
  'server',
  'terminal',
  'circle',
  'check',
  'alert',
  'shield',
  'chat',
  'plugs',
  'magnifying-glass',
  'graph',
  'toolbox',
  'plus',
  'refresh',
] as const

export type ExtensionIcon = (typeof EXTENSION_ICONS)[number]

export interface ExtensionCommandContribution {
  id: string
  title: string
  category?: string
  usage?: string
  argument?: string
  palette: boolean
  stdin: boolean
  interactive?: true
  capabilities: Capability[]
}

export const PANEL_TOOLBAR_MAX_TABS = 6

export const PANEL_TOOLBAR_MAX_ACTIONS = 6

export const PANEL_TOOLBAR_BACK_MAX = 60

export interface PanelToolbarTab {
  id: string
  title: string
}

export interface PanelToolbarAction {
  id: string
  icon: ExtensionIcon
  title: string
}

export interface PanelToolbarContribution {
  tabs: PanelToolbarTab[]
  actions: PanelToolbarAction[]
}

export interface PanelToolbarState {
  tab?: string
  back?: string
  badges?: Record<string, number>
  disabled?: string[]
  hidden?: string[]
}

export interface PanelToolbarEntry {
  extId: string
  workspaceId: string
  state: PanelToolbarState
}

export interface ExtensionPanelContribution {
  title: string
  icon?: ExtensionIcon
  entry: string
  toolbar?: PanelToolbarContribution
}

export interface ExtensionSettingsPageContribution {
  title: string
  icon?: ExtensionIcon
}

export interface ExtensionChipContribution {
  id: string
  title: string
}

export const EXTENSION_SETTING_TYPES = ['string', 'number', 'boolean', 'enum'] as const

export type ExtensionSettingType = (typeof EXTENSION_SETTING_TYPES)[number]

export type ExtensionSettingValue = string | number | boolean

export type ExtensionSettingValues = Record<string, ExtensionSettingValue>

export const EXTENSION_SETTING_UNITS = ['seconds', 'per-minute'] as const

export type ExtensionSettingUnit = (typeof EXTENSION_SETTING_UNITS)[number]

export interface ExtensionSettingContribution {
  key: string
  type: ExtensionSettingType
  default: ExtensionSettingValue
  title?: string
  description: string
  values?: string[]
  valueTitles?: Record<string, string>
  minimum?: number
  maximum?: number
  unit?: ExtensionSettingUnit
}

export const EXTENSION_SETTING_STRING_MAX = 1000
export const EXTENSION_SETTING_TITLE_MAX = 80
export const PRODUCT_PLACEHOLDER = '{product}'

export function validSettingValue(
  setting: ExtensionSettingContribution,
  value: unknown,
): value is ExtensionSettingValue {
  switch (setting.type) {
    case 'string':
      return typeof value === 'string' && value.length <= EXTENSION_SETTING_STRING_MAX
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (setting.minimum === undefined || value >= setting.minimum) &&
        (setting.maximum === undefined || value <= setting.maximum)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'enum':
      return typeof value === 'string' && (setting.values ?? []).includes(value)
  }
}

export function effectiveSettingValues(
  settings: readonly ExtensionSettingContribution[],
  stored: unknown,
): ExtensionSettingValues {
  const raw = isRecord(stored) ? stored : {}
  const out: ExtensionSettingValues = {}
  for (const setting of settings) {
    const value = Object.hasOwn(raw, setting.key) ? raw[setting.key] : undefined
    out[setting.key] = validSettingValue(setting, value) ? value : setting.default
  }
  return out
}

export interface ExtensionSecretContribution {
  key: string
  title?: string
  description: string
}

export const EXTENSION_SECRET_MAX = 4096

export const EXTENSION_CATEGORIES = [
  'ai',
  'scm',
  'tools',
  'themes',
  'langpack',
  'completions',
  'languages',
  'other',
] as const

export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number]

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  api: string
  description: string
  category: ExtensionCategory
  capabilities: Capability[]
  main?: string
  locales?: string[]
  contributes: {
    commands: ExtensionCommandContribution[]
    sidebarItems: boolean
    panel?: ExtensionPanelContribution
    paneChips: ExtensionChipContribution[]
    workspaceChips: ExtensionChipContribution[]
    settings: ExtensionSettingContribution[]
    settingsPage?: ExtensionSettingsPageContribution
    snippets?: Snippet[]
    completions?: string
    assist: AssistPoint[]
    secrets: ExtensionSecretContribution[]
    connections?: ExtensionConnectionKind[]
    iconThemes?: IconThemeContribution[]
    languages?: LanguageContribution[]
    keymaps?: KeymapContribution[]
    languageServers?: LanguageServerContribution[]
    editorLanguages?: EditorLanguageContribution[]
    fileKinds?: FileKindContribution[]
    agentSkills?: AgentSkillContribution[]
    agentHooks?: AgentHookContribution[]
    verb?: string
  }
}

export type ExtensionStatus =
  | 'pending-approval'
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'running'
  | 'crashed'

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  category: ExtensionCategory
  builtin: boolean
  enabled: boolean
  status: ExtensionStatus
  requested: Capability[]
  granted: Capability[]
  unapproved: Capability[]
  verb?: string
  commands: ExtensionCommandContribution[]
  panel: { title: string; icon?: ExtensionIcon; toolbar?: PanelToolbarContribution } | null
  paneChips: ExtensionChipContribution[]
  workspaceChips: ExtensionChipContribution[]
  settings: ExtensionSettingContribution[]
  settingValues: ExtensionSettingValues
  settingsPage: ExtensionSettingsPageContribution | null
  assist: AssistPoint[]
  secrets: ExtensionSecretContribution[]
  secretsSet: string[]
  connectionKinds: ExtensionConnectionKind[]
  iconThemes: IconThemeInfo[]
  languages: LanguageInfo[]
  keymaps: KeymapInfo[]
  languageServers: LanguageServerSummary[]
  fileKinds: FileKindInfo[]
  agentSkills: string[]
  agentSkillProblems: string[]
  agentHooks: AgentHookSummary[]
}

export const SIDEBAR_TONES = ['neutral', 'brand', 'ok', 'warn', 'error'] as const

export type SidebarTone = (typeof SIDEBAR_TONES)[number]

export const SIDEBAR_KINDS = ['location', 'live'] as const

export type SidebarKind = (typeof SIDEBAR_KINDS)[number]

export interface ExtensionSidebarItem {
  extId: string
  key: string
  workspaceId?: string
  text: string
  icon?: ExtensionIcon
  badge?: string
  tone: SidebarTone
  kind: SidebarKind
  url?: string
}

export const SIDEBAR_BADGE_PATTERN = /^[A-Za-z0-9]{1,6}$/

export const SIDEBAR_URL_MAX = 2048

export const PANE_CHIP_TEXT_MAX = 40
export const PANE_CHIP_TOOLTIP_MAX = 200
export const PANE_CHIP_ITEMS_MAX = 20
export const PANE_CHIP_ITEM_TEXT_MAX = 80

export interface PaneChipItem {
  text: string
  detail?: string
  url?: string
}

export interface ExtensionChip {
  extId: string
  id: string
  text: string
  tooltip?: string
  tone: SidebarTone
  icon?: ExtensionIcon
  items?: PaneChipItem[]
  command?: string
  url?: string
}

export interface PaneChip extends ExtensionChip {
  paneId: string
}

export interface WorkspaceChip extends ExtensionChip {
  workspaceId: string
}

export const COMMAND_ARGUMENT_LABEL_MAX = 80
export const COMMAND_ARGUMENT_MAX = 1000

export function commandArgument(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > COMMAND_ARGUMENT_MAX) return null
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null
  }
  return value
}

export const PANEL_PATH_MAX = 2048

export function panelPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw.length > PANEL_PATH_MAX) return null
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code < 0x21 || code === 0x7f || raw[i] === '\\') return null
  }
  return raw
}

export function sidebarItemUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > SIDEBAR_URL_MAX) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function paneChipItems(raw: unknown): PaneChipItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PANE_CHIP_ITEMS_MAX) return null
  const items: PaneChipItem[] = []
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>
    const text = typeof e.text === 'string' ? e.text.trim().slice(0, PANE_CHIP_ITEM_TEXT_MAX) : ''
    if (!text) return null
    const detail =
      typeof e.detail === 'string' ? e.detail.trim().slice(0, PANE_CHIP_ITEM_TEXT_MAX) : ''
    const item: PaneChipItem = detail ? { text, detail } : { text }
    if (e.url === undefined) {
      items.push(item)
      continue
    }
    const url = sidebarItemUrl(e.url)
    if (!url) return null
    items.push({ ...item, url })
  }
  return items
}

export type ExtensionCallerKind = 'pane' | 'user'

export interface ExtensionCaller {
  kind: ExtensionCallerKind
  paneId?: string
  workspaceId?: string
  workDir?: string
  cwd?: string
  locale?: string
  sandboxed?: boolean
  remote?: RemoteCwd
  manager?: boolean
  agentRunning?: boolean
  humanPrompt?: string
  capabilities: Capability[]
}

export const EXTENSION_EVENT_TYPES = [
  'pane.created',
  'pane.closed',
  'command.started',
  'command.finished',
  'cwd.changed',
  'focus.changed',
  'notification',
  'pane.attention',
  'pane.lifecycle',
  'bus.message',
  'workspace.closed',
] as const

export type ExtensionEventType = (typeof EXTENSION_EVENT_TYPES)[number]

export type PaneAttentionEventState = 'working' | 'waiting' | 'done' | 'error' | 'cleared'

export type PaneLifecycleEventState = 'hibernated' | 'woken'

export type BusMessageKind = 'message' | 'task'

export type BusMessagePhase = 'queued' | 'delivered' | 'failed'

export interface BusEndpoint {
  id: string
  workspaceId?: string
}

export interface ExtensionEventPayloads {
  'pane.created': { paneId: string; workspaceId: string }
  'pane.closed': { paneId: string; workspaceId: string }
  'command.started': { paneId: string; workspaceId: string; cwd?: string }
  'command.finished': {
    paneId: string
    workspaceId: string
    cwd?: string
    exitCode?: number
    remote?: boolean
  }
  'cwd.changed': { paneId: string; workspaceId: string; cwd: string }
  'pane.attention': { paneId: string; workspaceId: string; state: PaneAttentionEventState }
  'pane.lifecycle': { paneId: string; workspaceId: string; state: PaneLifecycleEventState }
  'bus.message': {
    id: string
    from: BusEndpoint
    to: BusEndpoint
    kind: BusMessageKind
    phase: BusMessagePhase
  }
  'focus.changed': { focused: boolean }
  notification: { title: string; body?: string; from: string }
  'workspace.closed': { workspaceId: string }
}

export type SandboxDomainsResult =
  | { ok: true; domains: string[] }
  | { ok: false; error: string; message?: string }

export interface ExtensionSettingsChangedPayload {
  values: ExtensionSettingValues
}

export const SETTINGS_CHANGED_EVENT = 'settings.changed'
export const ASSIST_PROVIDERS_CHANGED_EVENT = 'assist.providers.changed'

export const TARGET_PANE_PARAM = 'targetPaneId'

export type ExtensionResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

export type WireRuntimeResult =
  | { ok: true; socket: string; token: string; started: boolean; mode: string; version: string }
  | { ok: false; error: string; contract?: number; version?: string; message?: string }

export const DIFF_TEXT_MAX = 5 * 1024 * 1024

export interface DiffContent {
  title: string
  original: string
  modified: string
  language?: string
  path?: string
}

export const TERMINAL_COMMAND_MAX_ARGS = 64
export const TERMINAL_ARG_MAX = 4096
export const TERMINAL_TITLE_MAX = 80

export interface OpenTerminalOptions {
  command: string[]
  workspaceId?: string
  afterPaneId?: string
  cwd?: string
  title?: string
  host?: boolean
  waitMs?: number
}

export const OPEN_TERMINAL_WAIT_MAX_MS = 10 * 60_000

export const EXTENSION_REDACT_TEXTS_MAX = 16
export const EXTENSION_REDACT_TEXT_MAX = 16_000

export type TerminalWaitOutcome = 'finished' | 'closed' | 'timeout'

export interface TerminalWait {
  outcome: TerminalWaitOutcome
  exitCode?: number
}

export const AGENT_OFFER_TEXT_MAX = 2000
export const AGENT_OFFER_LABEL_MAX = 120
export const AGENT_PROMPT_MAX = 16_000

export interface AgentOfferOptions {
  workspaceId: string
  text: string
  label: string
}

export type AgentOfferResult =
  | { ok: true; sent: false }
  | { ok: true; sent: true; paneId: string }
  | { ok: false; error: string; message?: string }

export interface RunAgentOptions {
  workspaceId: string
  agent?: string
  prompt: string
  background?: boolean
  continueFrom?: string
  afterPaneId?: string
}

export const EXEC_TIMEOUT_MAX_MS = 600_000
export const EXEC_OUTPUT_DEFAULT = 64 * 1024
export const EXEC_OUTPUT_MAX = 1024 * 1024
export const EXEC_ENV_MAX = 16
export const EXEC_ENV_VALUE_MAX = 4096
export const BUS_SEND_TEXT_MAX = 16_000
export const WAKE_WAIT_MAX_MS = 120_000
export const EXTENSION_VERB_PATTERN = /^[a-z][a-z0-9-]{1,19}$/
