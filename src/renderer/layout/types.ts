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
}

export interface SplitNode {
  type: 'split'
  id: string
  direction: Direction
  children: LayoutNode[]
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
