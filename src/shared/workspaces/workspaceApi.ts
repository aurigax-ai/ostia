import type { ExtensionOpenTerminalRequest } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type {
  SnippetDocument,
  SnippetListing,
  SnippetSaveResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import type { AgentResume, ResumeFailure } from '../agents/agentResume'
import type { BrowserDevice } from '../browser/browserDevice'
import type { BrowserProfile } from '../browser/browserProfile'
import type { SandboxMergeRefusal } from '../sandbox/sandbox'
import type { CmuxSessionRead } from './cmuxSession'
import type { SplitTabPlacement } from './splitTabs'
import type { WorkspaceGroupColor } from './workspaceGroups'

export type SnapshotSurfaceKind =
  | 'terminal'
  | 'editor'
  | 'agent'
  | 'browser'
  | 'chat'
  | 'git'
  | 'view'

export interface SnapshotPaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SnapshotSurfaceKind
  cwd?: string
  filePath?: string
  viewType?: string
  url?: string
  chatSessionId?: string
  agentSessionId?: string
  viewName?: string
  browserProfile?: BrowserProfile
  browserDevice?: BrowserDevice
  resume?: AgentResume
  resumeFailed?: ResumeFailure
  agentRunning?: true
  hibernated?: true
  keepAwake?: true
  locked?: true
  defaultTitle?: true
  titlePinned?: true
  collapsed?: true
}

export interface SnapshotSplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: SnapshotNode[]
  sizes: number[]
  name?: string
  folded?: true
}

export interface ProcessTerminalRequest extends ExtensionOpenTerminalRequest {
  openedPaneIds?: string[]
  splitTab?: SplitTabPlacement
}

export type SnapshotTabNode = SnapshotPaneNode | SnapshotSplitNode

interface SnapshotTabsNode {
  type: 'tabs'
  id: string
  children: SnapshotTabNode[]
  activeId: string
}

export type SnapshotNode = SnapshotPaneNode | SnapshotSplitNode | SnapshotTabsNode

export interface SnapshotWorkspace {
  id: string
  name: string
  customName?: string
  description?: string
  pinned?: boolean
  groupId?: string
  kind: 'terminal' | 'scratch'
  workDir: string
  projectDir?: string
  anchored?: true
  root?: SnapshotNode
  activePaneId?: string
  origin?: WorkspaceOrigin
}

export type PanePlacementZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface PanePlacement {
  paneId: string
  zone: PanePlacementZone
}

export interface WorkspaceOrigin {
  workspaceId: string
  index: number
  groupId?: string
  beside?: PanePlacement
}

export interface SnapshotGroup {
  id: string
  name: string
  color?: WorkspaceGroupColor
  collapsed?: boolean
}

export type SnapshotLeftPanel = 'files'

export interface AppSnapshot {
  v: 1
  savedAt: string
  activeWorkspaceId: string | null
  workspaces: SnapshotWorkspace[]
  groups: SnapshotGroup[]
  leftPanel?: SnapshotLeftPanel
  rightPanel?: string
  bounds?: WindowBounds
  detachedBounds?: Record<string, WindowBounds>
  windows?: SnapshotWindow[]
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapshotWindow {
  id: string
  bounds: WindowBounds
  activeWorkspaceId: string | null
  leftPanel?: SnapshotLeftPanel
  rightPanel?: string
  workspaces: SnapshotWorkspace[]
}

interface ScratchApi {
  create: () => Promise<string | null>
  files: (workspaceId: string) => Promise<number>
  reveal: (workspaceId: string) => void
}

interface OpenWaitsApi {
  onEnded: (cb: (paneIds: string[]) => void) => () => void
}

type WorkspaceMergeError = 'not-owned' | 'manager' | SandboxMergeRefusal

export type WorkspaceMergeResult = { ok: true } | { ok: false; error: WorkspaceMergeError }

export type PaneMoveError = 'not-owned' | 'manager' | 'sandbox' | 'scratch'

export type PaneMoveResult = { ok: true } | { ok: false; error: PaneMoveError }

interface WorkspaceApi {
  save: (snapshot: AppSnapshot | null) => void
  load: () => Promise<AppSnapshot | null>
  merge: (sourceId: string, targetId: string) => Promise<WorkspaceMergeResult>
  movePanes: (sourceId: string, targetId: string, paneIds: string[]) => Promise<PaneMoveResult>
  readCmux: (path?: string) => Promise<CmuxSessionRead>
  isRemote: (workspaceId: string) => Promise<boolean>
}

interface SnippetsApi {
  list: (workspaceId: string | null) => Promise<SnippetListing>
  save: (doc: SnippetDocument) => Promise<SnippetSaveResult>
}

export interface WorkspaceBridge {
  workspace: WorkspaceApi
  scratch: ScratchApi
  openWaits: OpenWaitsApi
  snippets: SnippetsApi
}
