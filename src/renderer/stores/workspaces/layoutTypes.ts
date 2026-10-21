import type { AgentResume } from '@shared/agents/agentResume'
import type { ShownDiff } from '@shared/boards/git'
import type { BrowserDevice } from '@shared/browser/browserDevice'
import type { BrowserProfile } from '@shared/browser/browserProfile'
import type { SplitTabPlacement } from '@shared/workspaces/splitTabs'
import type { PanePlacement } from '@shared/workspaces/workspaceApi'
import type { StoreApi } from 'zustand'
import type { CollapseChange } from '@/lib/layout/collapse'
import type { DropZone } from '@/lib/layout/tree'
import type { Direction, LayoutNode, SurfaceKind } from '@/lib/layout/types'

export interface WorkspaceLayout {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: string | null
  equalized?: number
}

export interface LayoutState {
  byWorkspace: Record<string, WorkspaceLayout>
  ensure: (workspaceId: string) => void
  hydrate: (layouts: Record<string, WorkspaceLayout>) => void
  split: (workspaceId: string, paneId: string, direction: Direction) => void
  newTab: (
    workspaceId: string,
    paneId: string,
    kind: NewTabKind,
    browserProfile?: BrowserProfile,
  ) => string | null
  closePane: (workspaceId: string, paneId: string) => void
  focusPane: (workspaceId: string, paneId: string) => void
  resize: (workspaceId: string, splitId: string, sizes: number[]) => void
  zoomPane: (workspaceId: string, paneId: string, zoom?: boolean) => void
  movePane: (workspaceId: string, sourceId: string, targetId: string, zone: DropZone) => void
  moveTab: (workspaceId: string, sourceId: string, targetId: string, after: boolean) => void
  joinTab: (workspaceId: string, paneIds: readonly string[], tab: string | null) => string[]
  renameSplitTab: (workspaceId: string, tabId: string, name: string) => void
  changeCollapse: (workspaceId: string, paneId: string, change: CollapseChange) => void
  foldSplitTab: (workspaceId: string, tabId: string) => void
  setCwd: (workspaceId: string, paneId: string, cwd: string) => void
  setUrl: (workspaceId: string, paneId: string, url: string) => void
  setBrowserDevice: (workspaceId: string, paneId: string, device: BrowserDevice | null) => void
  setResume: (workspaceId: string, paneId: string, resume: AgentResume) => void
  setResumePending: (workspaceId: string, paneId: string, pending: boolean) => void
  failResume: (workspaceId: string, paneId: string, resume: AgentResume, exitCode: number) => void
  clearResumeFailure: (workspaceId: string, paneId: string) => void
  setHibernated: (workspaceId: string, paneId: string, hibernated: boolean) => void
  setSpawnDir: (workspaceId: string, paneId: string, spawnDir: string) => void
  settleSpawnDir: (workspaceId: string, paneId: string, missing: boolean) => void
  setLocked: (workspaceId: string, paneId: string, locked: boolean) => void
  isLocked: (workspaceId: string, paneId?: string) => boolean
  setTitle: (workspaceId: string, paneId: string, title: string) => void
  setViewType: (workspaceId: string, paneId: string, viewType: string | null) => void
  followMovedFile: (from: string, to: string) => void
  rename: (workspaceId: string, paneId: string, title: string) => void
  setDefaultTitle: (workspaceId: string, paneId: string, title: string) => void
  openFile: (workspaceId: string, path: string) => void
  openFileTab: (
    workspaceId: string,
    path: string,
    paneId?: string,
    background?: boolean,
    fresh?: boolean,
  ) => string | null
  openFileBeside: (workspaceId: string, path: string) => void
  openTerminalTab: (workspaceId: string, cwd: string) => string | null
  openBrowser: (workspaceId: string, url: string, profile: BrowserProfile) => void
  openBrowserTab: (
    workspaceId: string,
    url: string,
    profile: BrowserProfile,
    placement?: { beside?: string; background?: boolean },
  ) => string | null
  openGit: (workspaceId: string, title: string) => string | null
  openView: (workspaceId: string, viewName: string, title: string) => string | null
  openDiff: (workspaceId: string, content: ShownDiff) => string | null
  openChat: (workspaceId: string, title: string) => string | null
  openAgent: (workspaceId: string, title: string, sessionId?: string) => string | null
  setAgentSession: (workspaceId: string, paneId: string, sessionId: string, title: string) => void
  setChatSession: (workspaceId: string, paneId: string, sessionId: string, title: string) => void
  openTerminal: (workspaceId: string, opts: OpenTerminalPlacement) => string | null
  openManager: (workspaceId: string, opts: { cwd: string; title: string }) => string | null
  removeWorkspace: (workspaceId: string) => void
  release: (workspaceId: string) => void
  releasePane: (workspaceId: string, paneId: string) => void
  merge: (sourceId: string, targetId: string) => void
  moveTabTo: (sourceId: string, targetId: string, tabId: string) => string[]
  adopt: (layouts: Record<string, WorkspaceLayout>) => void
  graft: (workspaceId: string, layout: WorkspaceLayout, beside?: PanePlacement) => void
}

export interface OpenTerminalPlacement {
  afterPaneId?: string
  openedPaneIds?: string[]
  cwd?: string
  title?: string
  backgroundTab?: boolean
  splitTab?: SplitTabPlacement
}

type NewTabKind = Extract<SurfaceKind, 'terminal' | 'browser'>

export type LayoutSet = StoreApi<LayoutState>['setState']
export type LayoutGet = StoreApi<LayoutState>['getState']
