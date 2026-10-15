import type { AgentResume } from '@shared/agents/agentResume'
import type { BrowserProfile } from '@shared/browser/browserProfile'

export type Direction = 'horizontal' | 'vertical'

export type SurfaceKind =
  | 'terminal'
  | 'editor'
  | 'agent'
  | 'browser'
  | 'extension'
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
  url?: string
  extensionId?: string
  chatSessionId?: string
  viewName?: string
  browserProfile?: BrowserProfile
  resume?: AgentResume
  hibernated?: true
  resumePending?: true
  spawnDir?: string
  resumeFolderMissing?: string
  locked?: true
  defaultTitle?: true
  titlePinned?: true
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: Direction
  children: LayoutNode[]
  sizes: number[]
  name?: string
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
