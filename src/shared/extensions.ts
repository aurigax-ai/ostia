import type { Capability } from './capabilities'

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
] as const

export type ExtensionIcon = (typeof EXTENSION_ICONS)[number]

export interface ExtensionCommandContribution {
  id: string
  title: string
  category?: string
  usage?: string
  palette: boolean
  stdin: boolean
  capabilities: Capability[]
}

export interface ExtensionPanelContribution {
  title: string
  icon?: ExtensionIcon
  entry: string
}

export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description: string
  capabilities: Capability[]
  main?: string
  contributes: {
    commands: ExtensionCommandContribution[]
    sidebarItems: boolean
    panel?: ExtensionPanelContribution
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
  builtin: boolean
  enabled: boolean
  status: ExtensionStatus
  requested: Capability[]
  granted: Capability[]
  unapproved: Capability[]
  commands: ExtensionCommandContribution[]
  panel: { title: string; icon?: ExtensionIcon } | null
}

export const SIDEBAR_TONES = ['neutral', 'brand', 'ok', 'warn', 'error'] as const

export type SidebarTone = (typeof SIDEBAR_TONES)[number]

export interface ExtensionSidebarItem {
  extId: string
  key: string
  sessionId?: string
  text: string
  icon?: ExtensionIcon
  tone: SidebarTone
}

export type ExtensionCallerKind = 'pane' | 'user'

export interface ExtensionCaller {
  kind: ExtensionCallerKind
  paneId?: string
  sessionId?: string
  workDir?: string
  cwd?: string
  locale?: string
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
  'pane.created': { paneId: string; sessionId: string }
  'pane.closed': { paneId: string; sessionId: string }
  'command.started': { paneId: string; sessionId: string; cwd?: string }
  'command.finished': { paneId: string; sessionId: string; cwd?: string; exitCode?: number }
  'cwd.changed': { paneId: string; sessionId: string; cwd: string }
  'focus.changed': { focused: boolean }
  notification: { title: string; body?: string; from: string }
}

export type ExtensionResult =
  | { ok: true; text?: string; data?: unknown }
  | { ok: false; error: string; message?: string }

export type ExtensionPanelSource = { ok: true; src: string } | { ok: false; error: string }

export interface ExtensionOpenPanelRequest {
  extId: string
  sessionId?: string
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
  sessionId?: string
}

export interface ExtensionsApi {
  list: () => Promise<ExtensionInfo[]>
  setEnabled: (extId: string, enabled: boolean) => Promise<ExtensionInfo[]>
  approve: (extId: string) => Promise<ExtensionInfo[]>
  invoke: (
    extId: string,
    command: string,
    target: { sessionId: string | null; paneId: string | null },
  ) => Promise<ExtensionResult>
  panel: (
    extId: string,
    context: { sessionId: string; locale: string },
  ) => Promise<ExtensionPanelSource>
  sidebarItems: () => Promise<ExtensionSidebarItem[]>
  onChanged: (cb: (list: ExtensionInfo[]) => void) => () => void
  onSidebar: (cb: (items: ExtensionSidebarItem[]) => void) => () => void
  onOpenPanel: (cb: (req: ExtensionOpenPanelRequest) => void) => () => void
  onOpenDiff: (cb: (req: ExtensionOpenDiffRequest) => void) => () => void
}
