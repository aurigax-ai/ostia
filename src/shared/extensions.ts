import type { AssistPoint } from './assist'
import type { Capability } from './capabilities'
import type { EditorLanguageContribution } from './editorLanguages'
import type { IconThemeContribution, IconThemeInfo } from './iconTheme'
import type { LanguageContribution, LanguageInfo } from './languagePack'
import type { LanguageServerContribution, LanguageServerSummary } from './languageServers'
import type { Workflow } from './workflows'

export const EXTENSION_MANIFEST_FILE = 'pine.json'

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

export interface ExtensionPanelContribution {
  title: string
  icon?: ExtensionIcon
  entry: string
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
  const raw =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {}
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
    workflows?: Workflow[]
    completions?: string
    assist: AssistPoint[]
    secrets: ExtensionSecretContribution[]
    iconThemes?: IconThemeContribution[]
    languages?: LanguageContribution[]
    languageServers?: LanguageServerContribution[]
    editorLanguages?: EditorLanguageContribution[]
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
  commands: ExtensionCommandContribution[]
  panel: { title: string; icon?: ExtensionIcon } | null
  paneChips: ExtensionChipContribution[]
  workspaceChips: ExtensionChipContribution[]
  settings: ExtensionSettingContribution[]
  settingValues: ExtensionSettingValues
  settingsPage: ExtensionSettingsPageContribution | null
  assist: AssistPoint[]
  secrets: ExtensionSecretContribution[]
  secretsSet: string[]
  iconThemes: IconThemeInfo[]
  languages: LanguageInfo[]
  languageServers: LanguageServerSummary[]
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
  tone: SidebarTone
  kind: SidebarKind
  url?: string
}

export const SIDEBAR_URL_MAX = 2048

export const PANE_CHIP_TEXT_MAX = 40
export const PANE_CHIP_TOOLTIP_MAX = 200
export const PANE_CHIP_ITEMS_MAX = 20
export const PANE_CHIP_ITEM_TEXT_MAX = 80

export interface PaneChipItem {
  text: string
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
    if (e.url === undefined) {
      items.push({ text })
      continue
    }
    const url = sidebarItemUrl(e.url)
    if (!url) return null
    items.push({ text, url })
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
] as const

export type ExtensionEventType = (typeof EXTENSION_EVENT_TYPES)[number]

export interface ExtensionEventPayloads {
  'pane.created': { paneId: string; workspaceId: string }
  'pane.closed': { paneId: string; workspaceId: string }
  'command.started': { paneId: string; workspaceId: string; cwd?: string }
  'command.finished': { paneId: string; workspaceId: string; cwd?: string; exitCode?: number }
  'cwd.changed': { paneId: string; workspaceId: string; cwd: string }
  'focus.changed': { focused: boolean }
  notification: { title: string; body?: string; from: string }
}

export interface ExtensionSettingsChangedPayload {
  values: ExtensionSettingValues
}

export const SETTINGS_CHANGED_EVENT = 'settings.changed'
export const ASSIST_PROVIDERS_CHANGED_EVENT = 'assist.providers.changed'

export const TARGET_PANE_PARAM = 'targetPaneId'

export type ExtensionResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

export type ExtensionPanelSource = { ok: true; src: string } | { ok: false; error: string }

export interface ExtensionOpenPanelRequest {
  extId: string
  workspaceId?: string
  path?: string
}

export interface ExtensionPanelContext {
  workspaceId: string
  locale: string
  path?: string
}

export type ExtensionSettingResult =
  | { ok: true; stored: ExtensionSettingValues; list: ExtensionInfo[] }
  | { ok: false; error: string }

export type ExtensionSecretResult =
  | { ok: true; list: ExtensionInfo[] }
  | { ok: false; error: string }
export interface ExtensionSettingsStored {
  extId: string
  stored: ExtensionSettingValues
}

export const DIFF_TEXT_MAX = 5 * 1024 * 1024

export interface DiffContent {
  title: string
  original: string
  modified: string
  language?: string
  path?: string
}

export interface ExtensionOpenDiffRequest extends DiffContent {
  extId: string
  workspaceId?: string
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
  agent: string
  prompt: string
}

export interface ExtensionAgentOffer {
  requestId: string
  extId: string
  extName: string
  workspaceId: string
  label: string
  text: string
}

export interface ExtensionOpenTerminalRequest {
  requestId: string
  command: string
  hostToken?: string
  workspaceId?: string
  afterPaneId?: string
  cwd?: string
  title?: string
  backgroundTab?: boolean
  pinTitle?: boolean
}

export interface ExtensionsApi {
  list: () => Promise<ExtensionInfo[]>
  setEnabled: (extId: string, enabled: boolean) => Promise<ExtensionInfo[]>
  approve: (extId: string) => Promise<ExtensionInfo[]>
  invoke: (
    extId: string,
    command: string,
    target: { workspaceId: string | null; paneId: string | null },
    argument?: string,
  ) => Promise<ExtensionResult>
  panel: (extId: string, context: ExtensionPanelContext) => Promise<ExtensionPanelSource>
  sidebarItems: () => Promise<ExtensionSidebarItem[]>
  paneChips: () => Promise<PaneChip[]>
  workspaceChips: () => Promise<WorkspaceChip[]>
  setSetting: (extId: string, key: string, value: unknown) => Promise<ExtensionSettingResult>
  setSecret: (extId: string, key: string, value: string | null) => Promise<ExtensionSecretResult>
  onChanged: (cb: (list: ExtensionInfo[]) => void) => () => void
  onSidebar: (cb: (items: ExtensionSidebarItem[]) => void) => () => void
  onPaneChips: (cb: (chips: PaneChip[]) => void) => () => void
  onWorkspaceChips: (cb: (chips: WorkspaceChip[]) => void) => () => void
  onSettingsStored: (cb: (update: ExtensionSettingsStored) => void) => () => void
  onOpenPanel: (cb: (req: ExtensionOpenPanelRequest) => void) => () => void
  onOpenDiff: (cb: (req: ExtensionOpenDiffRequest) => void) => () => void
  onOpenTerminal: (cb: (req: ExtensionOpenTerminalRequest) => string | null) => () => void
  onAgentOffer: (cb: (offer: ExtensionAgentOffer) => void) => () => void
  onAgentOfferWithdrawn: (cb: (requestId: string) => void) => () => void
  answerAgentOffer: (requestId: string, paneId: string | null) => void
  onFocusPane: (cb: (paneId: string) => void) => () => void
}
