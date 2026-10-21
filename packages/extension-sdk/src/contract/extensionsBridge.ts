import type {
  ExtensionConnectionEntry,
  ExtensionConnectionResult,
  ExtensionConnectionSave,
} from './extensionConnections'
import type {
  DiffContent,
  ExtensionInfo,
  ExtensionResult,
  ExtensionSettingValues,
  ExtensionSidebarItem,
  InboxEntry,
  PaneChip,
  PanelToolbarEntry,
  WorkspaceChip,
} from './extensions'

export const PANEL_VISIBILITY_EVENT = 'ostia-panel-visibility'

export interface PanelVisibility {
  hidden: boolean
}

export const PANEL_TOOLBAR_EVENT = 'ostia-panel-toolbar'

export const PANEL_TOOLBAR_PATH = '/toolbar'

export type PanelToolbarEvent = { kind: 'tab' | 'action'; id: string } | { kind: 'back' }

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

export interface ExtensionOpenDiffRequest extends DiffContent {
  extId: string
  workspaceId?: string
}

export interface ExtensionOpenFileRequest {
  extId: string
  workspaceId: string
  path: string
  line?: number
  column?: number
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
  panelToolbars: () => Promise<PanelToolbarEntry[]>
  inboxEntries: () => Promise<InboxEntry[]>
  inboxAction: (extId: string, workspaceId: string, id: string) => Promise<boolean>
  paneChips: () => Promise<PaneChip[]>
  workspaceChips: () => Promise<WorkspaceChip[]>
  setSetting: (extId: string, key: string, value: unknown) => Promise<ExtensionSettingResult>
  setSecret: (extId: string, key: string, value: string | null) => Promise<ExtensionSecretResult>
  connections: (extId: string) => Promise<ExtensionConnectionEntry[]>
  saveConnection: (
    extId: string,
    connection: ExtensionConnectionSave,
  ) => Promise<ExtensionConnectionResult>
  removeConnection: (extId: string, name: string) => Promise<ExtensionConnectionResult>
  onChanged: (cb: (list: ExtensionInfo[]) => void) => () => void
  onSidebar: (cb: (items: ExtensionSidebarItem[]) => void) => () => void
  onPanelToolbars: (cb: (entries: PanelToolbarEntry[]) => void) => () => void
  onInbox: (cb: (entries: InboxEntry[]) => void) => () => void
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
