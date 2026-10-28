import type { AgentResume, ResumeFailure } from '@shared/agents/agentResume'
import type { BrowserDevice } from '@shared/browser/browserDevice'
import type { BrowserProfile } from '@shared/browser/browserProfile'

export type Direction = 'horizontal' | 'vertical'

export type SurfaceKind =
  | 'terminal'
  | 'editor'
  | 'agent'
  | 'browser'
  | 'diff'
  | 'chat'
  | 'git'
  | 'view'
  | 'manager'

export interface PaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  viewType?: string
  url?: string
  chatSessionId?: string
  agentSessionId?: string
  managerSession?: true
  viewName?: string
  browserProfile?: BrowserProfile
  browserDevice?: BrowserDevice
  resume?: AgentResume
  hibernated?: true
  keepAwake?: true
  resumePending?: true
  spawnDir?: string
  resumeFolderMissing?: string
  resumeFailed?: ResumeFailure
  locked?: true
  defaultTitle?: true
  titlePinned?: true
  collapsed?: true
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: Direction
  children: LayoutNode[]
  sizes: number[]
  name?: string
  folded?: true
}

export type TabNode = PaneNode | SplitNode

export interface TabsNode {
  type: 'tabs'
  id: string
  children: TabNode[]
  activeId: string
}

export type LayoutNode = PaneNode | SplitNode | TabsNode

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
