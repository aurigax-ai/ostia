import type { AgentResume } from '@shared/agentResume'
import type { BrowserProfile } from '@shared/browserProfile'

export type Direction = 'horizontal' | 'vertical'

export type SurfaceKind =
  | 'terminal'
  | 'editor'
  | 'agent'
  | 'browser'
  | 'extension'
  | 'diff'
  | 'chat'
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
  locked?: true
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: Direction
  children: LayoutNode[]
  sizes: number[]
}

export interface TabsNode {
  type: 'tabs'
  id: string
  children: PaneNode[]
  activeId: string
}

export type LayoutNode = PaneNode | SplitNode | TabsNode

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
