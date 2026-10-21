import type { ResumableAgent } from '../agents/agentResume'
import type { AttentionState, WorkspaceLiveState } from '../attention/attention'
import type { PanePlacement, SnapshotWorkspace } from '../workspaces/workspaceApi'

interface WindowControls {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  quit: () => void
  isMaximized: () => Promise<boolean>
  setZoom: (percent: number) => Promise<number>
  beep: () => void
  writePrimarySelection: (text: string) => void
  isSystemDark: () => Promise<boolean>
  onSystemDarkChange: (cb: (dark: boolean) => void) => () => void
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  onRunningQuery: (cb: (kept: string[]) => RunningGroup[] | Promise<RunningGroup[]>) => () => void
  onConfirmClose: (cb: (question: QuitQuestion) => Promise<QuitAnswer>) => () => void
  onFreeze: (cb: () => void) => () => void
}

export type QuitAnswer = 'cancel' | 'quit' | 'keep-shells'

interface QuitQuestion {
  groups: RunningGroup[]
  keptShells: string[]
}

export interface RunningGroup {
  workspaceId: string
  workspace: string
  commands: string[]
  agents?: string[]
  files: string[]
  scratchFiles?: number
  unanswered?: boolean
}

export interface WindowInfo {
  windowId: string
  detached: boolean
}

export interface WindowPaneSummary {
  id: string
  title: string
}

export interface WindowWorkspaceSummary {
  id: string
  name: string
  workDir: string
  state: WorkspaceLiveState
  unreadAt: number
  panes: WindowPaneSummary[]
}

export interface WindowSummary {
  windowId: string
  detached: boolean
  workspaces: WindowWorkspaceSummary[]
}

export type PaneAgentKind = ResumableAgent | 'other'

export interface WindowPaneReport extends WindowPaneSummary {
  agent?: PaneAgentKind
  state?: AttentionState
  cwd?: string
}

export interface WindowWorkspaceReport extends WindowWorkspaceSummary {
  origin?: string
  panes: WindowPaneReport[]
}

export interface OriginAgentTarget {
  paneId: string
  title: string
  agent: PaneAgentKind
  state: AttentionState
  cwd?: string
}

export interface OriginAgents {
  workspaceId: string
  workspaceName: string
  targets: OriginAgentTarget[]
}

export interface OriginReferenceRequest {
  workspaceId: string
  paneId: string
  text: string
  note?: string
}

export interface ReferenceInsert {
  requestId: string
  paneId: string
  text: string
  note?: string
}

export interface NewWorkspaceRequest {
  dir?: string
  name?: string
  scratch?: boolean
  sandboxed?: boolean
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface PaneDrop {
  paneId: string
  workspaceId: string
  placement: PanePlacement
}

interface WindowsApi {
  info: () => Promise<WindowInfo>
  detach: (workspace: SnapshotWorkspace, at?: ScreenPoint) => Promise<boolean>
  dropPane: (drop: PaneDrop) => void
  landing: (paneId: string) => Promise<boolean>
  give: (workspace: SnapshotWorkspace) => Promise<boolean>
  returnToMain: (workspaces: SnapshotWorkspace[]) => Promise<boolean>
  openWith: (workspaces: SnapshotWorkspace[]) => Promise<boolean>
  report: (workspaces: WindowWorkspaceReport[]) => void
  focusWorkspace: (workspaceId: string, jumpToUnread: boolean, takesKeyboard: boolean) => void
  returnWorkspace: (workspaceId: string) => void
  newWorkspace: (request: NewWorkspaceRequest) => void
  onList: (cb: (list: WindowSummary[]) => void) => () => void
  onAdopt: (cb: (workspaces: SnapshotWorkspace[]) => void) => () => void
  onActivateWorkspace: (
    cb: (workspaceId: string, jumpToUnread: boolean, takesKeyboard: boolean) => void,
  ) => () => void
  onReturnRequest: (cb: () => void) => () => void
  originAgents: (workspaceId: string) => Promise<OriginAgents | null>
  onOriginAgentsChanged: (cb: () => void) => () => void
  insertReference: (request: OriginReferenceRequest) => Promise<boolean>
  onInsertReference: (cb: (insert: ReferenceInsert) => void) => () => void
  answerInsertReference: (requestId: string, inserted: boolean) => void
}

export interface WindowsBridge {
  window: WindowControls
  windows: WindowsApi
}
