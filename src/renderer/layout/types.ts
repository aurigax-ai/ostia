import type { AgentResume } from '@shared/agentResume'

export type Direction = 'horizontal' | 'vertical'

export type SurfaceKind = 'terminal' | 'editor' | 'agent' | 'browser' | 'extension' | 'diff'

export interface PaneNode {
  type: 'pane'
  id: string
  title: string
  kind: SurfaceKind
  cwd?: string
  filePath?: string
  url?: string
  extensionId?: string
  resume?: AgentResume
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
